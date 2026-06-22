/**
 * S3 Files Access Point Management — per-scope workspace mounts
 *
 * Creates and manages S3 Files Access Points for business scopes.
 * Each scope gets a dedicated access point with:
 *   - Root directory: /{organizationId}/{scopeId}  (no trailing slash — the
 *     S3 Files API rejects trailing slashes via a regex constraint)
 *   - POSIX user: uid=1000, gid=1000 (matches node user in container)
 *
 * The S3 Files CreateAccessPoint API does NOT accept a caller-supplied name;
 * it assigns an opaque id (fsap-xxxx). We therefore identify a scope's access
 * point by its rootDirectory path, and persist the returned ARN in
 * business_scopes.workspace_access_point_arn so it is created only once.
 */

import { config } from '../config/index.js';
import { prisma } from '../config/database.js';

let S3FilesClient: any;
let CreateAccessPointCommand: any;
let DeleteAccessPointCommand: any;
let ListAccessPointsCommand: any;
let sdkLoaded = false;

async function ensureSDK(): Promise<void> {
  if (sdkLoaded) return;
  try {
    const mod = await import('@aws-sdk/client-s3files' as string);
    S3FilesClient = mod.S3FilesClient;
    CreateAccessPointCommand = mod.CreateAccessPointCommand;
    DeleteAccessPointCommand = mod.DeleteAccessPointCommand;
    ListAccessPointsCommand = mod.ListAccessPointsCommand;
    sdkLoaded = true;
    console.log('[s3files] SDK loaded');
  } catch (err) {
    throw new Error(`S3 Files SDK not available. Install @aws-sdk/client-s3files. Error: ${err}`);
  }
}

/**
 * The S3 Files filesystem id, accepted either as a bare id (fs-xxxx) or a full
 * ARN. CreateAccessPoint expects the bare id, so normalize here.
 */
function resolveFileSystemId(): string {
  const raw = config.agentcore.s3FilesFileSystemId;
  if (!raw) {
    throw new Error('AGENTCORE_S3FILES_FILESYSTEM_ID is not configured');
  }
  // Full ARN form: arn:aws:s3files:...:file-system/fs-xxxx → take the id after the last "/"
  return raw.startsWith('arn:') ? raw.split('/').pop()! : raw;
}

/** Root directory path for a scope's access point (no trailing slash). */
function scopeRootDirectory(organizationId: string, scopeId: string): string {
  return `/${organizationId}/${scopeId}`;
}

/**
 * Find an existing access point for a scope by its rootDirectory path.
 * Returns the access point ARN, or null if none exists.
 */
async function findAccessPointByPath(
  client: any,
  fileSystemId: string,
  rootPath: string
): Promise<string | null> {
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new ListAccessPointsCommand({ fileSystemId, nextToken }));
    for (const ap of resp.accessPoints ?? []) {
      if (ap.rootDirectory?.path === rootPath && ap.accessPointArn) {
        return ap.accessPointArn as string;
      }
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return null;
}

/**
 * Get or create an S3 Files Access Point for a business scope.
 * Returns { arn: string } with the fully-qualified access point ARN.
 */
export async function getOrCreateAccessPoint(
  organizationId: string,
  scopeId: string
): Promise<{ arn: string }> {
  // Check if access point already exists in DB
  const scope = await prisma.business_scopes.findUnique({
    where: { id: scopeId },
    select: { workspace_access_point_arn: true },
  });

  if (!scope) {
    throw new Error(`Scope ${scopeId} not found`);
  }

  if (scope.workspace_access_point_arn) {
    return { arn: scope.workspace_access_point_arn };
  }

  await ensureSDK();

  const fileSystemId = resolveFileSystemId();
  const rootDirectory = scopeRootDirectory(organizationId, scopeId);
  const client = new S3FilesClient({ region: config.aws.region });

  // Reuse an existing access point if one already covers this scope's path
  // (e.g. created by a prior run before the ARN was persisted).
  const existing = await findAccessPointByPath(client, fileSystemId, rootDirectory);
  if (existing) {
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { workspace_access_point_arn: existing },
    });
    console.log(`[s3files] Reusing existing access point for scope ${scopeId}: ${existing}`);
    return { arn: existing };
  }

  // CreateAccessPoint does NOT accept a name; it assigns an opaque id.
  // rootDirectory.path must not have a trailing slash.
  const response = await client.send(
    new CreateAccessPointCommand({
      fileSystemId,
      rootDirectory: { path: rootDirectory },
      posixUser: {
        uid: 1000, // node user in container
        gid: 1000,
      },
    })
  );

  const arn = response.accessPointArn;
  if (!arn) {
    throw new Error('CreateAccessPoint returned no ARN');
  }

  await prisma.business_scopes.update({
    where: { id: scopeId },
    data: { workspace_access_point_arn: arn },
  });

  console.log(
    `[s3files] Created access point for scope ${scopeId}: ${arn} (status=${response.status})`
  );
  return { arn };
}

/**
 * Delete an S3 Files Access Point for a business scope.
 * Used when a scope is permanently deleted.
 */
export async function deleteAccessPoint(scopeId: string): Promise<void> {
  const scope = await prisma.business_scopes.findUnique({
    where: { id: scopeId },
    select: { workspace_access_point_arn: true },
  });

  if (!scope?.workspace_access_point_arn) {
    console.log(`[s3files] No access point to delete for scope ${scopeId}`);
    return;
  }

  await ensureSDK();

  const arn = scope.workspace_access_point_arn;

  // Extract the access point id (fsap-xxxx) from the ARN.
  // Format: arn:aws:s3files:region:account:file-system/fs-xxxx/access-point/fsap-xxxx
  const accessPointId = arn.split('/').pop();
  if (!accessPointId) {
    throw new Error(`Invalid access point ARN: ${arn}`);
  }

  const client = new S3FilesClient({ region: config.aws.region });

  try {
    const command = new DeleteAccessPointCommand({ accessPointId });
    await client.send(command);
    console.log(`[s3files] Deleted access point for scope ${scopeId}: ${arn}`);

    // Clear ARN from database
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { workspace_access_point_arn: null },
    });
  } catch (err: any) {
    if (err?.name === 'NoSuchAccessPoint' || err?.code === 'NoSuchAccessPoint') {
      console.log(`[s3files] Access point already deleted: ${arn}`);
      await prisma.business_scopes.update({
        where: { id: scopeId },
        data: { workspace_access_point_arn: null },
      });
      return;
    }
    throw err;
  }
}

export const s3FilesService = {
  getOrCreateAccessPoint,
  deleteAccessPoint,
};
