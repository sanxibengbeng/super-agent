/**
 * S3 Files Access Point Management — per-scope workspace mounts
 *
 * Creates and manages S3 Files Access Points for business scopes.
 * Each scope gets a dedicated access point with:
 *   - Root directory: /{organizationId}/{scopeId}/
 *   - POSIX user: uid=1000, gid=1000 (matches node user in container)
 *   - Name: scope-{scopeId-first-8-chars}
 *
 * The access point ARN is stored in business_scopes.workspace_access_point_arn
 * so it only needs to be created once per scope.
 */

import { config } from '../config/index.js';
import { prisma } from '../config/database.js';

let S3FilesClient: any;
let CreateAccessPointCommand: any;
let DeleteAccessPointCommand: any;
let sdkLoaded = false;

async function ensureSDK(): Promise<void> {
  if (sdkLoaded) return;
  try {
    const mod = await import('@aws-sdk/client-s3files' as string);
    S3FilesClient = mod.S3FilesClient;
    CreateAccessPointCommand = mod.CreateAccessPointCommand;
    DeleteAccessPointCommand = mod.DeleteAccessPointCommand;
    sdkLoaded = true;
    console.log('[s3files] SDK loaded');
  } catch (err) {
    throw new Error(`S3 Files SDK not available. Install @aws-sdk/client-s3files. Error: ${err}`);
  }
}

/**
 * Get or create an S3 Files Access Point for a business scope.
 * Returns { arn: string } with the fully-qualified access point ARN.
 */
export async function getOrCreateAccessPoint(
  organizationId: string,
  scopeId: string,
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

  // Create new access point
  await ensureSDK();

  const fileSystemId = config.agentcore.s3FilesFileSystemId;
  if (!fileSystemId) {
    throw new Error('AGENTCORE_S3FILES_FILESYSTEM_ID is not configured');
  }

  // Derive access point name from scopeId (S3 Files names must be unique per account)
  // Format: scope-{first-8-chars-of-uuid}
  const apName = `scope-${scopeId.slice(0, 8)}`;

  const client = new S3FilesClient({ region: config.aws.region });

  try {
    const command = new CreateAccessPointCommand({
      fileSystemId,
      name: apName,
      rootDirectory: `/${organizationId}/${scopeId}/`,
      posixUser: {
        uid: 1000, // node user in container
        gid: 1000,
      },
    });

    const response = await client.send(command);
    const arn = response.accessPointArn;

    if (!arn) {
      throw new Error('CreateAccessPoint returned no ARN');
    }

    // Store ARN in database
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { workspace_access_point_arn: arn },
    });

    console.log(`[s3files] Created access point for scope ${scopeId}: ${arn}`);
    return { arn };
  } catch (err: any) {
    // If access point already exists (race condition or manual creation),
    // reconstruct the ARN and store it
    if (err?.name === 'AccessPointAlreadyExists' || err?.code === 'AccessPointAlreadyExists') {
      const accountId = await getAccountId();
      const arn = `arn:aws:s3files:${config.aws.region}:${accountId}:access-point/${fileSystemId}/${apName}`;
      await prisma.business_scopes.update({
        where: { id: scopeId },
        data: { workspace_access_point_arn: arn },
      });
      console.log(`[s3files] Access point already exists, stored ARN: ${arn}`);
      return { arn };
    }
    throw err;
  }
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
  const fileSystemId = config.agentcore.s3FilesFileSystemId;

  if (!fileSystemId) {
    throw new Error('AGENTCORE_S3FILES_FILESYSTEM_ID is not configured');
  }

  // Extract access point name from ARN
  // Format: arn:aws:s3files:region:account:access-point/filesystemId/apName
  const apName = arn.split('/').pop();
  if (!apName) {
    throw new Error(`Invalid access point ARN: ${arn}`);
  }

  const client = new S3FilesClient({ region: config.aws.region });

  try {
    const command = new DeleteAccessPointCommand({
      fileSystemId,
      name: apName,
    });
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

/**
 * Get AWS account ID from STS (for constructing ARNs).
 */
async function getAccountId(): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region: config.aws.region });
  const response = await sts.send(new GetCallerIdentityCommand({}));
  return response.Account!;
}

export const s3FilesService = {
  getOrCreateAccessPoint,
  deleteAccessPoint,
};
