/**
 * Unit tests for AppStorage service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppStorage } from '../../src/services/app-storage.js';
import type { S3Client } from '@aws-sdk/client-s3';

// Mock S3Client
const mockSend = vi.fn();
const mockS3Client = {
  send: mockSend,
} as unknown as S3Client;

describe('AppStorage', () => {
  let appStorage: AppStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    appStorage = new AppStorage('test-bucket', 'us-east-1', mockS3Client);
  });

  describe('getKeyPrefix', () => {
    it('should return correct S3 prefix format', () => {
      const appId = 'test-app-123';
      const prefix = appStorage.getKeyPrefix(appId);
      expect(prefix).toBe('_published_apps/test-app-123/');
    });

    it('should handle different app IDs', () => {
      expect(appStorage.getKeyPrefix('app-1')).toBe('_published_apps/app-1/');
      expect(appStorage.getKeyPrefix('app-2')).toBe('_published_apps/app-2/');
      expect(appStorage.getKeyPrefix('uuid-format-123-456')).toBe('_published_apps/uuid-format-123-456/');
    });
  });

  describe('getObject', () => {
    it('should return body and content type for existing object', async () => {
      const mockBody = new Uint8Array([1, 2, 3, 4, 5]);
      const mockTransformToByteArray = vi.fn().mockResolvedValue(mockBody);

      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: mockTransformToByteArray,
        },
        ContentType: 'text/html',
        ContentLength: 5,
      });

      const result = await appStorage.getObject('app-123', 'index.html');

      expect(result).not.toBeNull();
      expect(result?.body).toEqual(mockBody);
      expect(result?.contentType).toBe('text/html');
      expect(result?.contentLength).toBe(5);

      // Verify the S3 command was called with correct parameters
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Key: '_published_apps/app-123/index.html',
          }),
        })
      );
    });

    it('should return null for NoSuchKey error', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      mockSend.mockRejectedValueOnce(noSuchKeyError);

      const result = await appStorage.getObject('app-123', 'missing.html');

      expect(result).toBeNull();
    });

    it('should return null for 404 status code', async () => {
      const notFoundError: any = new Error('Not Found');
      notFoundError.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValueOnce(notFoundError);

      const result = await appStorage.getObject('app-123', 'missing.html');

      expect(result).toBeNull();
    });

    it('should throw error for other S3 errors', async () => {
      const accessDeniedError = new Error('Access Denied');
      accessDeniedError.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(accessDeniedError);

      await expect(appStorage.getObject('app-123', 'index.html')).rejects.toThrow('Access Denied');
    });

    it('should default to application/octet-stream if ContentType is missing', async () => {
      const mockBody = new Uint8Array([1, 2, 3]);
      const mockTransformToByteArray = vi.fn().mockResolvedValue(mockBody);

      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: mockTransformToByteArray,
        },
        ContentType: undefined,
        ContentLength: 3,
      });

      const result = await appStorage.getObject('app-123', 'file.bin');

      expect(result?.contentType).toBe('application/octet-stream');
    });
  });

  describe('deletePrefix', () => {
    it('should list and delete all objects under prefix', async () => {
      // Mock list response with 2 objects
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/index.html' },
          { Key: '_published_apps/app-123/style.css' },
        ],
        NextContinuationToken: undefined,
      });

      // Mock delete response
      mockSend.mockResolvedValueOnce({});

      const count = await appStorage.deletePrefix('app-123');

      expect(count).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(2); // Once for list, once for delete

      // Verify list command
      expect(mockSend).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Prefix: '_published_apps/app-123/',
          }),
        })
      );

      // Verify delete command
      expect(mockSend).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Delete: {
              Objects: [
                { Key: '_published_apps/app-123/index.html' },
                { Key: '_published_apps/app-123/style.css' },
              ],
            },
          }),
        })
      );
    });

    it('should handle empty prefix (no objects)', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [],
        NextContinuationToken: undefined,
      });

      const count = await appStorage.deletePrefix('app-123');

      expect(count).toBe(0);
      expect(mockSend).toHaveBeenCalledTimes(1); // Only list, no delete
    });

    it('should handle pagination in listing', async () => {
      // First page
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/file1.html' },
        ],
        NextContinuationToken: 'token-1',
      });

      // Second page
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/file2.html' },
        ],
        NextContinuationToken: undefined,
      });

      // Delete
      mockSend.mockResolvedValueOnce({});

      const count = await appStorage.deletePrefix('app-123');

      expect(count).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(3); // 2 list calls + 1 delete
    });

    it('should handle large batches (>1000 objects)', async () => {
      // Create 1500 mock objects
      const objects = Array.from({ length: 1500 }, (_, i) => ({
        Key: `_published_apps/app-123/file${i}.html`,
      }));

      mockSend.mockResolvedValueOnce({
        Contents: objects,
        NextContinuationToken: undefined,
      });

      // Two delete calls (1000 + 500)
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      const count = await appStorage.deletePrefix('app-123');

      expect(count).toBe(1500);
      expect(mockSend).toHaveBeenCalledTimes(3); // 1 list + 2 deletes
    });
  });

  describe('listFiles', () => {
    it('should return relative file paths', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/index.html' },
          { Key: '_published_apps/app-123/css/style.css' },
          { Key: '_published_apps/app-123/js/app.js' },
        ],
        NextContinuationToken: undefined,
      });

      const files = await appStorage.listFiles('app-123');

      expect(files).toEqual([
        'index.html',
        'css/style.css',
        'js/app.js',
      ]);
    });

    it('should handle empty directory', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [],
        NextContinuationToken: undefined,
      });

      const files = await appStorage.listFiles('app-123');

      expect(files).toEqual([]);
    });

    it('should handle pagination', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/file1.html' },
        ],
        NextContinuationToken: 'token-1',
      });

      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/file2.html' },
        ],
        NextContinuationToken: undefined,
      });

      const files = await appStorage.listFiles('app-123');

      expect(files).toEqual(['file1.html', 'file2.html']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should skip the prefix key itself if present', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: '_published_apps/app-123/' }, // Directory marker
          { Key: '_published_apps/app-123/index.html' },
        ],
        NextContinuationToken: undefined,
      });

      const files = await appStorage.listFiles('app-123');

      // Should only include the file, not the empty directory marker
      expect(files).toEqual(['index.html']);
    });
  });
});
