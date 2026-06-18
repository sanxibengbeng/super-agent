/**
 * WhatsApp Bridge Adapter — Personal WhatsApp via QR Code
 *
 * Uses @whiskeysockets/baileys (WhatsApp Web multi-device protocol) to let users
 * connect their personal WhatsApp by scanning a QR code. Each binding maintains
 * its own Baileys socket with auth state persisted in Redis.
 *
 * Session lifecycle:
 *   1. addBot(binding) → creates socket → emits QR code if no saved session
 *   2. User scans QR → connection established → messages flow
 *   3. On disconnect → auto-reconnect (unless logged out)
 *   4. removeBot(bindingId) → close socket, clear Redis auth state
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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
import { imQueueService } from './im-queue.service.js';
import { redisService } from './redis.service.js';

type ConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

interface SocketEntry {
  socket: WASocket;
  bindingId: string;
}

const AUTH_PREFIX = 'whatsapp-bridge:auth:';

function authKey(bindingId: string, category: string): string {
  return `${AUTH_PREFIX}${bindingId}:${category}`;
}

async function useRedisAuthState(bindingId: string) {
  const client = redisService.getClient();
  const credsKey = authKey(bindingId, 'creds');

  const readCreds = async (): Promise<AuthenticationCreds | undefined> => {
    const raw = await client.get(credsKey);
    if (!raw) return undefined;
    return JSON.parse(raw) as AuthenticationCreds;
  };

  const writeCreds = async (creds: AuthenticationCreds): Promise<void> => {
    await client.set(credsKey, JSON.stringify(creds));
  };

  const readKey = async (type: string, id: string): Promise<unknown> => {
    const raw = await client.get(authKey(bindingId, `${type}:${id}`));
    if (!raw) return undefined;
    return JSON.parse(raw);
  };

  const writeKey = async (type: string, id: string, value: unknown): Promise<void> => {
    await client.set(authKey(bindingId, `${type}:${id}`), JSON.stringify(value));
  };

  const removeKey = async (type: string, id: string): Promise<void> => {
    await client.del(authKey(bindingId, `${type}:${id}`));
  };

  const creds = (await readCreds()) || ({} as AuthenticationCreds);

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

export class WhatsAppBridgeAdapter implements IMAdapter {
  private sockets = new Map<string, SocketEntry>();
  private qrCodes = new Map<string, string>();
  private statuses = new Map<string, ConnectionStatus>();

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

  async startGateway(): Promise<void> {
    const bindings = await this.discoverBindings();
    if (bindings.length === 0) {
      console.log('[WHATSAPP-BRIDGE] No enabled bindings found, gateway idle');
      return;
    }

    for (const binding of bindings) {
      try {
        await this.connectSocket(binding);
      } catch (err) {
        console.error(
          `[WHATSAPP-BRIDGE] Failed to connect binding ${binding.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async stopGateway(): Promise<void> {
    for (const [bindingId, entry] of this.sockets) {
      try {
        entry.socket.end(undefined);
        console.log(`[WHATSAPP-BRIDGE] Disconnected binding ${bindingId}`);
      } catch (err) {
        console.error(
          `[WHATSAPP-BRIDGE] Error disconnecting ${bindingId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.sockets.clear();
    this.qrCodes.clear();
    this.statuses.clear();
  }

  async addBot(binding: IMChannelBindingEntity): Promise<void> {
    if (this.sockets.has(binding.id)) return;
    await this.connectSocket(binding);
  }

  removeBot(bindingId: string): void {
    const entry = this.sockets.get(bindingId);
    if (entry) {
      entry.socket.end(undefined);
      this.sockets.delete(bindingId);
    }
    this.qrCodes.delete(bindingId);
    this.statuses.set(bindingId, 'disconnected');
    clearRedisAuthState(bindingId).catch((err) => {
      console.error(
        `[WHATSAPP-BRIDGE] Failed to clear auth state for ${bindingId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  getQRCode(bindingId: string): string | null {
    return this.qrCodes.get(bindingId) ?? null;
  }

  getConnectionStatus(bindingId: string): ConnectionStatus {
    return this.statuses.get(bindingId) ?? 'disconnected';
  }

  private async connectSocket(binding: IMChannelBindingEntity): Promise<void> {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useRedisAuthState(binding.id);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
    });

    this.sockets.set(binding.id, { socket: sock, bindingId: binding.id });
    this.statuses.set(binding.id, 'disconnected');

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

        imQueueService.enqueue(normalized).catch((err) => {
          console.error(
            '[WHATSAPP-BRIDGE] Failed to enqueue message:',
            err instanceof Error ? err.message : err,
          );
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
      this.qrCodes.set(bindingId, qr);
      this.statuses.set(bindingId, 'qr_pending');
      console.log(`[WHATSAPP-BRIDGE] QR code generated for binding ${bindingId}`);
    }

    if (connection === 'open') {
      this.qrCodes.delete(bindingId);
      this.statuses.set(bindingId, 'connected');
      console.log(`[WHATSAPP-BRIDGE] Connected binding ${bindingId}`);
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error as Boom | undefined;
      const statusCode = boom?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      this.sockets.delete(bindingId);

      if (isLoggedOut) {
        this.statuses.set(bindingId, 'disconnected');
        this.qrCodes.delete(bindingId);
        clearRedisAuthState(bindingId).catch((err) => {
          console.error(
            `[WHATSAPP-BRIDGE] Failed to clear auth after logout ${bindingId}:`,
            err instanceof Error ? err.message : err,
          );
        });
        console.log(`[WHATSAPP-BRIDGE] Logged out, session cleared for binding ${bindingId}`);
      } else {
        console.log(
          `[WHATSAPP-BRIDGE] Disconnected (code ${statusCode}), reconnecting binding ${bindingId}`,
        );
        setTimeout(() => {
          this.connectSocket(binding).catch((err) => {
            console.error(
              `[WHATSAPP-BRIDGE] Reconnect failed for ${bindingId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }, 3000);
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
