import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests for s3files.service getOrCreateAccessPoint.
 *
 * Regression coverage for the production bug where CreateAccessPoint was called
 * with an unsupported `name` field and a trailing-slash rootDirectory path,
 * causing the S3 Files API to reject it (surfaced as "Expected null" by a
 * client-s3files deserialization bug). The access point was therefore never
 * created and agent file writes never reached S3.
 */

const ORG = '26e45e72-030c-4b7e-8ac7-a967a6100906';
const SCOPE = 'fc059dc7-dd03-4169-af27-cacf799a457f';
const FS_ID = 'fs-0ac4f854e9e53dac5';
const CREATED_ARN = `arn:aws:s3files:us-east-1:873543029686:file-system/${FS_ID}/access-point/fsap-03246957e159c4224`;

// --- mock @aws-sdk/client-s3files ---
const sendMock = vi.fn();
class CreateAccessPointCommand { constructor(public input: any) {} }
class DeleteAccessPointCommand { constructor(public input: any) {} }
class ListAccessPointsCommand { constructor(public input: any) {} }
vi.mock('@aws-sdk/client-s3files', () => ({
  S3FilesClient: class { send = sendMock; },
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  ListAccessPointsCommand,
}));

// --- mock prisma ---
const findUnique = vi.fn();
const update = vi.fn();
vi.mock('../../src/config/database.js', () => ({
  prisma: {
    business_scopes: {
      findUnique: (...a: any[]) => findUnique(...a),
      update: (...a: any[]) => update(...a),
    },
  },
}));

// --- mock config (filesystem id supplied as a full ARN, as in prod) ---
vi.mock('../../src/config/index.js', () => ({
  config: {
    aws: { region: 'us-east-1' },
    agentcore: {
      s3FilesFileSystemId: `arn:aws:s3files:us-east-1:873543029686:file-system/${FS_ID}`,
      region: 'us-east-1',
    },
  },
}));

async function loadService() {
  return import('../../src/services/s3files.service.js');
}

describe('s3files.service getOrCreateAccessPoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({});
  });

  it('returns the stored ARN without calling AWS when one already exists', async () => {
    findUnique.mockResolvedValue({ workspace_access_point_arn: CREATED_ARN });
    const { getOrCreateAccessPoint } = await loadService();

    const result = await getOrCreateAccessPoint(ORG, SCOPE);

    expect(result.arn).toBe(CREATED_ARN);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('creates an access point with no name and a path without trailing slash', async () => {
    findUnique.mockResolvedValue({ workspace_access_point_arn: null });
    sendMock
      .mockResolvedValueOnce({ accessPoints: [] }) // ListAccessPoints
      .mockResolvedValueOnce({ accessPointArn: CREATED_ARN, status: 'creating' }); // CreateAccessPoint
    const { getOrCreateAccessPoint } = await loadService();

    const result = await getOrCreateAccessPoint(ORG, SCOPE);

    expect(result.arn).toBe(CREATED_ARN);
    const createCall = sendMock.mock.calls
      .map(c => c[0])
      .find(c => c instanceof CreateAccessPointCommand) as CreateAccessPointCommand;
    expect(createCall).toBeDefined();
    // bare filesystem id (normalized from the ARN form)
    expect(createCall.input.fileSystemId).toBe(FS_ID);
    // no caller-supplied name (API does not accept it)
    expect(createCall.input).not.toHaveProperty('name');
    // path without trailing slash
    expect(createCall.input.rootDirectory).toEqual({ path: `/${ORG}/${SCOPE}` });
    expect(createCall.input.rootDirectory.path.endsWith('/')).toBe(false);
    // posix user matches the container's node user
    expect(createCall.input.posixUser).toEqual({ uid: 1000, gid: 1000 });
    // ARN persisted to DB
    expect(update).toHaveBeenCalledWith({
      where: { id: SCOPE },
      data: { workspace_access_point_arn: CREATED_ARN },
    });
  });

  it('reuses an existing access point found by rootDirectory path', async () => {
    findUnique.mockResolvedValue({ workspace_access_point_arn: null });
    sendMock.mockResolvedValueOnce({
      accessPoints: [
        { accessPointArn: 'arn:other', rootDirectory: { path: '/' } },
        { accessPointArn: CREATED_ARN, rootDirectory: { path: `/${ORG}/${SCOPE}` } },
      ],
    });
    const { getOrCreateAccessPoint } = await loadService();

    const result = await getOrCreateAccessPoint(ORG, SCOPE);

    expect(result.arn).toBe(CREATED_ARN);
    // no CreateAccessPoint call — reused the existing one
    const created = sendMock.mock.calls
      .map(c => c[0])
      .some(c => c instanceof CreateAccessPointCommand);
    expect(created).toBe(false);
    expect(update).toHaveBeenCalledWith({
      where: { id: SCOPE },
      data: { workspace_access_point_arn: CREATED_ARN },
    });
  });

  it('deletes by accessPointId extracted from the ARN', async () => {
    findUnique.mockResolvedValue({ workspace_access_point_arn: CREATED_ARN });
    sendMock.mockResolvedValueOnce({});
    const { deleteAccessPoint } = await loadService();

    await deleteAccessPoint(SCOPE);

    const delCall = sendMock.mock.calls
      .map(c => c[0])
      .find(c => c instanceof DeleteAccessPointCommand) as DeleteAccessPointCommand;
    expect(delCall).toBeDefined();
    expect(delCall.input).toEqual({ accessPointId: 'fsap-03246957e159c4224' });
    expect(update).toHaveBeenCalledWith({
      where: { id: SCOPE },
      data: { workspace_access_point_arn: null },
    });
  });
});
