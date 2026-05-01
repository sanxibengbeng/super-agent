/**
 * App Storage Service
 * Manages published app file storage in S3 under _published_apps/ prefix.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readdir, stat, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { config } from '../config/index.js';

const S3_PREFIX = '_published_apps';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SKIP_PATTERNS = ['node_modules', '.git', '__pycache__', '.DS_Store'];

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export interface S3Object {
  body: Uint8Array;
  contentType: string;
  contentLength: number;
}

export class AppStorage {
  private s3Client: S3Client;
  private bucket: string;

  constructor(bucket: string, region: string, s3Client?: S3Client) {
    this.bucket = bucket;
    this.s3Client = s3Client ?? new S3Client({ region });
  }

  /**
   * Get the S3 key prefix for an app.
   */
  getKeyPrefix(appId: string): string {
    return `${S3_PREFIX}/${appId}/`;
  }

  /**
   * Upload a local directory to S3 recursively.
   * Skips node_modules, .git, __pycache__, .DS_Store, and files > 50MB.
   * @returns Count of uploaded files
   */
  async uploadDir(appId: string, localDir: string): Promise<number> {
    const prefix = this.getKeyPrefix(appId);
    let uploadCount = 0;

    const uploadFile = async (filePath: string): Promise<void> => {
      const relativePath = relative(localDir, filePath);
      const key = `${prefix}${relativePath}`;
      const content = await readFile(filePath);

      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
      }));

      uploadCount++;
    };

    const walkDir = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        // Skip patterns
        if (SKIP_PATTERNS.some(pattern => entry.name.includes(pattern))) {
          continue;
        }

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          if (stats.size <= MAX_FILE_SIZE) {
            await uploadFile(fullPath);
          }
        }
      }
    };

    await walkDir(localDir);
    return uploadCount;
  }

  /**
   * Get a single file from S3.
   * @returns S3Object or null if the key doesn't exist
   */
  async getObject(appId: string, filePath: string): Promise<S3Object | null> {
    const prefix = this.getKeyPrefix(appId);
    const key = `${prefix}${filePath}`;

    try {
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));

      const body = await response.Body?.transformToByteArray();
      if (!body) {
        return null;
      }

      return {
        body,
        contentType: response.ContentType ?? 'application/octet-stream',
        contentLength: response.ContentLength ?? body.length,
      };
    } catch (error: any) {
      // Return null for NoSuchKey errors (404)
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete all objects under the app prefix.
   * @returns Count of deleted objects
   */
  async deletePrefix(appId: string): Promise<number> {
    const prefix = this.getKeyPrefix(appId);
    let deleteCount = 0;

    // List all objects under the prefix
    let continuationToken: string | undefined;
    const objectsToDelete: { Key: string }[] = [];

    do {
      const listResponse = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        for (const obj of listResponse.Contents) {
          if (obj.Key) {
            objectsToDelete.push({ Key: obj.Key });
          }
        }
      }

      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);

    // Delete in batches (S3 allows up to 1000 objects per delete request)
    if (objectsToDelete.length > 0) {
      for (let i = 0; i < objectsToDelete.length; i += 1000) {
        const batch = objectsToDelete.slice(i, i + 1000);
        await this.s3Client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch },
        }));
        deleteCount += batch.length;
      }
    }

    return deleteCount;
  }

  /**
   * List all relative file paths under the app prefix.
   * @returns Array of relative file paths
   */
  async listFiles(appId: string): Promise<string[]> {
    const prefix = this.getKeyPrefix(appId);
    const files: string[] = [];

    let continuationToken: string | undefined;

    do {
      const listResponse = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        for (const obj of listResponse.Contents) {
          if (obj.Key) {
            // Remove the prefix to get relative path
            const relativePath = obj.Key.substring(prefix.length);
            if (relativePath) {
              files.push(relativePath);
            }
          }
        }
      }

      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);

    return files;
  }

  /**
   * List objects under an arbitrary S3 prefix (same bucket), returning
   * relative paths and ETags for content comparison.
   */
  async listS3Prefix(prefix: string): Promise<{ path: string; etag: string }[]> {
    const files: { path: string; etag: string }[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of res.Contents ?? []) {
        if (obj.Key) {
          const rel = obj.Key.substring(prefix.length);
          if (rel && !rel.endsWith('/')) {
            files.push({ path: rel, etag: obj.ETag ?? '' });
          }
        }
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return files;
  }

  /**
   * Compare two S3 prefixes by file paths and ETags.
   * Returns true if they contain the same files with identical content.
   */
  async prefixesMatch(prefixA: string, prefixB: string): Promise<boolean> {
    const [filesA, filesB] = await Promise.all([
      this.listS3Prefix(prefixA),
      this.listS3Prefix(prefixB),
    ]);

    if (filesA.length !== filesB.length) return false;

    const mapB = new Map(filesB.map(f => [f.path, f.etag]));
    return filesA.every(f => mapB.get(f.path) === f.etag);
  }

  /**
   * Check whether a specific key exists in S3.
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy all objects from a source prefix to an app's _published_apps/ prefix.
   * Uses same-bucket CopyObject (server-side, no data transfer).
   * @returns Count of copied objects
   */
  async copyFromPrefix(appId: string, sourcePrefix: string): Promise<number> {
    const destPrefix = this.getKeyPrefix(appId);
    const sourceFiles = await this.listS3Prefix(sourcePrefix);

    let copyCount = 0;
    for (const { path: relPath } of sourceFiles) {
      if (SKIP_PATTERNS.some(p => relPath.includes(p))) continue;

      await this.s3Client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourcePrefix}${relPath}`,
        Key: `${destPrefix}${relPath}`,
      }));
      copyCount++;
    }
    return copyCount;
  }
}

// Singleton export
export const appStorage = new AppStorage(
  config.agentcore.workspaceS3Bucket,
  config.agentcore.workspaceS3Region,
);
