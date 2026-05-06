import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubscriber = {
  on: vi.fn(),
  psubscribe: vi.fn().mockResolvedValue(undefined),
  punsubscribe: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue('OK'),
};

const mockClient = {
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn(),
  duplicate: vi.fn().mockReturnValue(mockSubscriber),
  publish: vi.fn().mockResolvedValue(1),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  quit: vi.fn().mockResolvedValue('OK'),
};

vi.mock('ioredis', () => {
  const RedisMock = function () {
    return mockClient;
  };
  return { default: RedisMock };
});

vi.mock('../../src/config/index.js', () => ({
  config: {
    redis: { host: 'localhost', port: 6379, password: '', db: 0 },
  },
}));

vi.mock('../../src/config/queue.js', () => ({
  NODE_LOCK_TTL_MS: 30000,
  POLL_LOCK_TTL_MS: 5000,
}));

import { RedisService } from '../../src/services/redis.service.js';

describe('RedisService Pub/Sub', () => {
  let service: RedisService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new RedisService();
    await service.initialize();
  });

  describe('publish', () => {
    it('should publish a message to a channel', async () => {
      await service.publish('workspace:events:session-1', '{"type":"task_completed"}');

      expect(mockClient.publish).toHaveBeenCalledWith(
        'workspace:events:session-1',
        '{"type":"task_completed"}'
      );
    });

    it('should throw if not initialized', async () => {
      const uninitService = new RedisService();
      await expect(
        uninitService.publish('channel', 'msg')
      ).rejects.toThrow('Redis service not initialized');
    });
  });

  describe('psubscribe', () => {
    it('should create a subscriber and register pattern', async () => {
      const handler = vi.fn();
      await service.psubscribe('workspace:events:*', handler);

      expect(mockClient.duplicate).toHaveBeenCalled();
      expect(mockSubscriber.psubscribe).toHaveBeenCalledWith('workspace:events:*');
      expect(mockSubscriber.on).toHaveBeenCalledWith('pmessage', expect.any(Function));
    });

    it('should reuse existing subscriber for multiple patterns', async () => {
      await service.psubscribe('pattern1:*', vi.fn());
      await service.psubscribe('pattern2:*', vi.fn());

      expect(mockClient.duplicate).toHaveBeenCalledTimes(1);
    });
  });

  describe('punsubscribe', () => {
    it('should remove pattern handler and unsubscribe', async () => {
      await service.psubscribe('workspace:events:*', vi.fn());
      await service.punsubscribe('workspace:events:*');

      expect(mockSubscriber.punsubscribe).toHaveBeenCalledWith('workspace:events:*');
    });
  });

  describe('shutdown', () => {
    it('should close subscriber on shutdown', async () => {
      await service.psubscribe('pattern:*', vi.fn());
      await service.shutdown();

      expect(mockSubscriber.quit).toHaveBeenCalled();
    });
  });
});
