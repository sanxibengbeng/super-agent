/**
 * WhatsApp Bridge Adapter — Personal WhatsApp via QR Code
 *
 * Architecture:
 * - Auth state (creds + signal keys) persisted in Redis → survives restarts
 * - QR codes and connection status stored in Redis → readable by any process
 * - Socket runs in the process that calls addBot() (api for /connect, gateway on startup)
 * - Messages processed directly in-process (socket + sendReply co-located)
 * - On ECS restart, gateway auto-reconnects using saved auth state (no re-scan)
 * - Redis distributed lock prevents duplicate sockets across multiple gateway instances
 *
 * Flow:
 *   1. User clicks Connect → API calls addBot() → socket created in API process
 *   2. QR scanned → auth state saved to Redis → connection established
 *   3. On restart → gateway startGateway() reconnects with saved auth (no QR needed)
 *   4. Messages received → handleMessage() in same process → sendReply() via local socket
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  Browsers,
} from '@whiskeysockets/baileys';
import type {
  ConnectionState,
  WASocket,
  AuthenticationCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';
import { redisService } from './redis.service.js';

type ConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

interface SocketEntry {
  socket: WASocket;
  bindingId: string;
}

const AUTH_PREFIX = 'whatsapp-bridge:auth:';
const QR_PREFIX = 'whatsapp-bridge:qr:';
const STATUS_PREFIX = 'whatsapp-bridge:status:';
const LOCK_PREFIX = 'whatsapp-bridge:lock:';
const QR_TTL = 120;
const LOCK_TTL = 60;

function authKey(bindingId: string, category: string): string {
  return `${AUTH_PREFIX}${bindingId}:${category}`;
}

async function useRedisAuthState(bindingId: string) {
  const client = redisService.getClient();
  const credsKey = authKey(bindingId, 'creds');

  const readCreds = async (): Promise<AuthenticationCreds | undefined> => {
    const raw = await client.get(credsKey);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw, BufferJSON.reviver) as AuthenticationCreds;
      if (!parsed.noiseKey || !parsed.signedIdentityKey) {
        console.warn(`[WHATSAPP-BRIDGE] Incomplete creds for ${bindingId}, reinitializing`);
        return undefined;
      }
      return parsed;
    } catch {
      console.warn(`[WHATSAPP-BRIDGE] Corrupt creds for ${bindingId}, reinitializing`);
      return undefined;
    }
  };

  const writeCreds = async (creds: AuthenticationCreds): Promise<void> => {
    await client.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
  };

  const readKey = async (type: string, id: string): Promise<unknown> => {
    const raw = await client.get(authKey(bindingId, `${type}:${id}`));
    if (!raw) return undefined;
    return JSON.parse(raw, BufferJSON.reviver);
  };

  const writeKey = async (type: string, id: string, value: unknown): Promise<void> => {
    await client.set(authKey(bindingId, `${type}:${id}`), JSON.stringify(value, BufferJSON.replacer));
  };

  const removeKey = async (type: string, id: string): Promise<void> => {
    await client.del(authKey(bindingId, `${type}:${id}`));
  };

  const creds = (await readCreds()) || initAuthCreds();

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(
        {
          get: async <T extends keyof SignalDataTypeMap>(
            type: T,
            ids: string[],
          ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
            const result: { [id: string]: SignalDataTypeMap[T] } = {};
            for (const id of ids) {
              const val = await readKey(type, id);
              if (val !== undefined) {
                result[id] = val as SignalDataTypeMap[T];
              }
            }
            return result;
          },
          set: async (data: Record<string, Record<string, unknown>>): Promise<void> => {
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries)) {
                if (value) {
                  await writeKey(type, id, value);
                } else {
                  await removeKey(type, id);
                }
              }
            }
          },
        },
        undefined as any,
      ),
    },
    saveCreds: async () => {
      await writeCreds(creds);
    },
  };
}

async function clearRedisAuthState(bindingId: string): Promise<void> {
  const client = redisService.getClient();
  const pattern = `${AUTH_PREFIX}${bindingId}:*`;
  let cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } while (cursor !== '0');
}

async function hasExistingAuth(bindingId: string): Promise<boolean> {
  const client = redisService.getClient();
  const raw = await client.get(authKey(bindingId, 'creds'));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw, BufferJSON.reviver);
    return !!(parsed.noiseKey && parsed.signedIdentityKey && parsed.me);
  } catch {
    return false;
  }
}

export class WhatsAppBridgeAdapter implements IMAdapter {
  private sockets = new Map<string, SocketEntry>();
  private reconnectAttempts = new Map<string, number>();
  private lockRenewIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private static MAX_RECONNECT = 5;
  private instanceId = `${process.pid}-${Date.now()}`;

  verifyRequest(_headers: Record<string, string>, _body: string): boolean {
    return true;
  }

  parseEvent(_body: unknown): NormalizedIMMessage | null {
    return null;
  }

  async sendReply(
    _binding: IMChannelBindingEntity,
    threadId: string,
    text: string,
    _replyContext?: Record<string, unknown>,
  ): Promise<void> {
    const bindingId = _binding.id;
    const entry = this.sockets.get(bindingId);
    if (!entry) {
      console.error(`[WHATSAPP-BRIDGE] No active socket for binding ${bindingId}`);
      return;
    }
    await entry.socket.sendMessage(threadId, { text });
  }

  /**
   * Gateway startup: reconnect all bindings that have saved auth state.
   * Uses distributed lock so only one gateway instance claims each binding.
   */
  async startGateway(): Promise<void> {
    const bindings = await this.discoverBindings();
    if (bindings.length === 0) {
      console.log('[WHATSAPP-BRIDGE] No enabled bindings found, gateway idle');
      return;
    }

    for (const binding of bindings) {
      const hasCreds = await hasExistingAuth(binding.id);
      if (!hasCreds) {
        console.log(`[WHATSAPP-BRIDGE] Binding ${binding.id} has no saved auth, skipping (needs /connect)`);
        continue;
      }

      const acquired = await this.acquireLock(binding.id);
      if (!acquired) {
        console.log(`[WHATSAPP-BRIDGE] Binding ${binding.id} locked by another instance, skipping`);
        continue;
      }

      try {
        await this.connectSocket(binding);
        console.log(`[WHATSAPP-BRIDGE] Reconnected binding ${binding.id} from saved auth`);
      } catch (err) {
        console.error(
          `[WHATSAPP-BRIDGE] Failed to reconnect binding ${binding.id}:`,
          err instanceof Error ? err.message : err,
        );
        await this.releaseLock(binding.id);
      }
    }
  }

  async stopGateway(): Promise<void> {
    for (const [bindingId, entry] of this.sockets) {
      try {
        entry.socket.end(undefined);
        await this.releaseLock(bindingId);
        console.log(`[WHATSAPP-BRIDGE] Disconnected binding ${bindingId}`);
      } catch (err) {
        console.error(
          `[WHATSAPP-BRIDGE] Error disconnecting ${bindingId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.sockets.clear();
  }

  async addBot(binding: IMChannelBindingEntity): Promise<void> {
    if (this.sockets.has(binding.id)) return;
    this.reconnectAttempts.delete(binding.id);
    const acquired = await this.acquireLock(binding.id);
    if (!acquired) {
      console.log(`[WHATSAPP-BRIDGE] Binding ${binding.id} already connected by another instance`);
      return;
    }
    await this.connectSocket(binding);
  }

  async removeBot(bindingId: string): Promise<void> {
    const entry = this.sockets.get(bindingId);
    if (entry) {
      entry.socket.end(undefined);
      this.sockets.delete(bindingId);
    }
    await this.releaseLock(bindingId);
    await this.setStatus(bindingId, 'disconnected');
    await this.clearQR(bindingId);
    clearRedisAuthState(bindingId).catch((err) => {
      console.error(
        `[WHATSAPP-BRIDGE] Failed to clear auth state for ${bindingId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  async getQRCode(bindingId: string): Promise<string | null> {
    const client = redisService.getClient();
    return await client.get(`${QR_PREFIX}${bindingId}`);
  }

  async getConnectionStatus(bindingId: string): Promise<ConnectionStatus> {
    const client = redisService.getClient();
    const status = await client.get(`${STATUS_PREFIX}${bindingId}`);
    return (status as ConnectionStatus) || 'disconnected';
  }

  // --- Distributed Lock ---

  private async acquireLock(bindingId: string): Promise<boolean> {
    const client = redisService.getClient();
    const key = `${LOCK_PREFIX}${bindingId}`;
    const result = await client.set(key, this.instanceId, 'EX', LOCK_TTL, 'NX');
    if (result === 'OK') {
      this.startLockRenewal(bindingId);
      return true;
    }
    return false;
  }

  private async releaseLock(bindingId: string): Promise<void> {
    const client = redisService.getClient();
    const key = `${LOCK_PREFIX}${bindingId}`;
    const holder = await client.get(key);
    if (holder === this.instanceId) {
      await client.del(key);
    }
    const interval = this.lockRenewIntervals.get(bindingId);
    if (interval) {
      clearInterval(interval);
      this.lockRenewIntervals.delete(bindingId);
    }
  }

  private startLockRenewal(bindingId: string): void {
    const interval = setInterval(async () => {
      const client = redisService.getClient();
      const key = `${LOCK_PREFIX}${bindingId}`;
      const holder = await client.get(key);
      if (holder === this.instanceId) {
        await client.expire(key, LOCK_TTL);
      } else {
        clearInterval(interval);
        this.lockRenewIntervals.delete(bindingId);
      }
    }, (LOCK_TTL / 2) * 1000);
    this.lockRenewIntervals.set(bindingId, interval);
  }

  // --- Redis State ---

  private async setQR(bindingId: string, qr: string): Promise<void> {
    const client = redisService.getClient();
    await client.set(`${QR_PREFIX}${bindingId}`, qr, 'EX', QR_TTL);
  }

  private async clearQR(bindingId: string): Promise<void> {
    const client = redisService.getClient();
    await client.del(`${QR_PREFIX}${bindingId}`);
  }

  private async setStatus(bindingId: string, status: ConnectionStatus): Promise<void> {
    const client = redisService.getClient();
    await client.set(`${STATUS_PREFIX}${bindingId}`, status);
  }

  // --- Socket Management ---

  private async connectSocket(binding: IMChannelBindingEntity): Promise<void> {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useRedisAuthState(binding.id);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    this.sockets.set(binding.id, { socket: sock, bindingId: binding.id });
    await this.setStatus(binding.id, 'disconnected');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(binding.id, update, binding);
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        const normalized: NormalizedIMMessage = {
          channelType: 'whatsapp-bridge',
          channelId: binding.channel_id,
          threadId: jid,
          userId: jid,
          userName: msg.pushName ?? undefined,
          text,
          bindingId: binding.id,
        };

        import('./im.service.js').then(({ imService }) => {
          imService.handleMessage(normalized).catch((err) => {
            console.error(
              '[WHATSAPP-BRIDGE] Failed to handle message:',
              err instanceof Error ? err.message : err,
            );
          });
        });
      }
    });
  }

  private handleConnectionUpdate(
    bindingId: string,
    update: Partial<ConnectionState>,
    binding: IMChannelBindingEntity,
  ): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.setQR(bindingId, qr).catch(() => {});
      this.setStatus(bindingId, 'qr_pending').catch(() => {});
      console.log(`[WHATSAPP-BRIDGE] QR code generated for binding ${bindingId}`);
    }

    if (connection === 'open') {
      this.reconnectAttempts.delete(bindingId);
      Promise.all([
        this.clearQR(bindingId),
        this.setStatus(bindingId, 'connected'),
      ]).catch(() => {});
      console.log(`[WHATSAPP-BRIDGE] Connected binding ${bindingId}`);
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error as Boom | undefined;
      const statusCode = boom?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isRestart = statusCode === 515;

      this.sockets.delete(bindingId);

      console.log(
        `[WHATSAPP-BRIDGE] Connection closed for ${bindingId}: code=${statusCode}, reason=${boom?.message ?? 'unknown'}`,
      );

      if (isLoggedOut) {
        this.reconnectAttempts.delete(bindingId);
        this.setStatus(bindingId, 'disconnected').catch(() => {});
        this.clearQR(bindingId).catch(() => {});
        this.releaseLock(bindingId).catch(() => {});
        clearRedisAuthState(bindingId).catch((err) => {
          console.error(
            `[WHATSAPP-BRIDGE] Failed to clear auth after logout ${bindingId}:`,
            err instanceof Error ? err.message : err,
          );
        });
        console.log(`[WHATSAPP-BRIDGE] Logged out, session cleared for binding ${bindingId}`);
      } else {
        if (isRestart) {
          this.reconnectAttempts.delete(bindingId);
        }

        const attempts = (this.reconnectAttempts.get(bindingId) || 0) + 1;
        this.reconnectAttempts.set(bindingId, attempts);

        if (attempts > WhatsAppBridgeAdapter.MAX_RECONNECT) {
          console.error(`[WHATSAPP-BRIDGE] Max reconnect attempts (${WhatsAppBridgeAdapter.MAX_RECONNECT}) reached for ${bindingId}, giving up`);
          this.setStatus(bindingId, 'disconnected').catch(() => {});
          this.releaseLock(bindingId).catch(() => {});
          this.reconnectAttempts.delete(bindingId);
          return;
        }

        const backoffMs = Math.min(3000 * Math.pow(2, attempts - 1), 30000);
        console.log(
          `[WHATSAPP-BRIDGE] Reconnecting ${attempts}/${WhatsAppBridgeAdapter.MAX_RECONNECT} in ${backoffMs}ms for ${bindingId}`,
        );
        setTimeout(() => {
          this.connectSocket(binding).catch((err) => {
            console.error(
              `[WHATSAPP-BRIDGE] Reconnect failed for ${bindingId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }, backoffMs);
      }
    }
  }

  private async discoverBindings(): Promise<IMChannelBindingEntity[]> {
    const { prisma } = await import('../config/database.js');
    const bindings = await prisma.im_channel_bindings.findMany({
      where: { channel_type: 'whatsapp-bridge', is_enabled: true },
    });
    return bindings as unknown as IMChannelBindingEntity[];
  }
}

export const whatsappBridgeAdapter = new WhatsAppBridgeAdapter();
