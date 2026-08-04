import { describe, expect, it, beforeAll } from "vitest";
import net from "net";
import crypto from "node:crypto";

const GAME_PORT = "45123";
process.env.GAME_PORT = GAME_PORT;

const { startGameServer } = await import("./gameServer");

const PORT = parseInt(GAME_PORT);

/** Réplica do cliente Java (com/mmo/c/a) usada para validar o handshake. */
class FakeClient {
  private socket = new net.Socket();
  private buffer = Buffer.alloc(0);
  private waiters: { size: number; resolve: (data: Buffer) => void }[] = [];
  readonly key = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicExponent: 65537,
  });
  readonly clientSecret = crypto.randomBytes(8);

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on("data", data => {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.flushWaiters();
      });
      this.socket.on("error", reject);
      this.socket.connect(PORT, "127.0.0.1", resolve);
    });
  }

  get closed(): boolean {
    return this.socket.destroyed || !this.socket.writable;
  }

  close(): void {
    this.socket.destroy();
  }

  write(data: Buffer): void {
    this.socket.write(data);
  }

  read(size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout esperando ${size} bytes`)),
        4000
      );
      this.waiters.push({
        size,
        resolve: data => {
          clearTimeout(timer);
          resolve(data);
        },
      });
      this.flushWaiters();
    });
  }

  /** Remove o envelope PKCS#1 v1.5 na mão: privateDecrypt recusa RSA_PKCS1_PADDING. */
  decrypt(block: Buffer): Buffer {
    const raw = crypto.privateDecrypt(
      { key: this.key.privateKey, padding: crypto.constants.RSA_NO_PADDING },
      block
    );
    return raw.subarray(raw.indexOf(0x00, 2) + 1);
  }

  encryptFor(publicKey: crypto.KeyObject, data: Buffer): Buffer {
    return crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      data
    );
  }

  /** BigInteger.toByteArray() do modulus (129 bytes com byte de sinal) + exponent. */
  publicKeyPacket(): Buffer {
    const jwk = this.key.publicKey.export({ format: "jwk" });
    const modulus = Buffer.from(jwk.n!, "base64url");
    const exponent = Buffer.alloc(4);
    exponent.writeInt32BE(65537, 0);
    return Buffer.concat([Buffer.from([0]), modulus, exponent]);
  }

  private flushWaiters(): void {
    while (
      this.waiters.length > 0 &&
      this.buffer.length >= this.waiters[0].size
    ) {
      const waiter = this.waiters.shift()!;
      const data = this.buffer.subarray(0, waiter.size);
      this.buffer = this.buffer.subarray(waiter.size);
      waiter.resolve(data);
    }
  }
}

/** Executa o handshake até o ponto anterior ao pacote de login. */
async function handshakeUntilLogin(client: FakeClient) {
  expect((await client.read(4)).readInt32BE(0)).toBe(25);

  const serverKeyPacket = await client.read(132);
  expect(serverKeyPacket.readInt32BE(128)).toBe(65537);
  const serverPublicKey = crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: serverKeyPacket.subarray(0, 128).toString("base64url"),
      e: Buffer.from([0x01, 0x00, 0x01]).toString("base64url"),
    },
    format: "jwk",
  });

  client.write(client.publicKeyPacket());

  const serverSecret = client.decrypt(await client.read(128));
  expect(serverSecret).toHaveLength(8);

  client.write(client.encryptFor(serverPublicKey, client.clientSecret));
  return { serverPublicKey, serverSecret };
}

/** Valida a resposta de login e os opcodes iniciais (com/mmo/c/a.b e c/c.a). */
async function expectLoginAndInitialState(client: FakeClient) {
  const response = client.decrypt(await client.read(128));
  expect(response.subarray(0, 8)).toEqual(client.clientSecret);
  expect(response[8]).toBe(1);
  expect(response.subarray(9, 21)).toHaveLength(12);

  const setPlayer = await client.read(5);
  expect(setPlayer[0]).toBe(0x02);
  expect(setPlayer.readInt32BE(1)).toBe(12345);

  const status = await client.read(17);
  expect(status[0]).toBe(0x18);
  expect([
    status.readInt32BE(1),
    status.readInt32BE(5),
    status.readInt32BE(9),
    status.readInt32BE(13),
  ]).toEqual([1000, 1000, 500, 500]);
}

describe("gameServer handshake", () => {
  beforeAll(async () => {
    await startGameServer();
  });

  it("completa o login local e envia os opcodes iniciais", async () => {
    const client = new FakeClient();
    await client.connect();
    const { serverPublicKey, serverSecret } = await handshakeUntilLogin(client);

    client.write(
      client.encryptFor(
        serverPublicKey,
        Buffer.concat([serverSecret, Buffer.from("OLDTOKEN0001")])
      )
    );
    await expectLoginAndInitialState(client);

    // Pacotes do cliente são prefixados por 2 bytes de tamanho (com/mmo/c/b.h)
    client.write(Buffer.from([0x00, 0x01, 0x02]));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(client.closed).toBe(false);
    client.close();
  });

  it("aceita o fluxo de login do Google e responde 1 byte de sucesso", async () => {
    const client = new FakeClient();
    await client.connect();
    const { serverPublicKey, serverSecret } = await handshakeUntilLogin(client);

    // com/mmo/c/a.c: [byte N][N blocos de 128 bytes]
    const blocks = [0, 1].map(index =>
      client.encryptFor(
        serverPublicKey,
        Buffer.concat([serverSecret, Buffer.from(`google-chunk-${index}`)])
      )
    );
    client.write(Buffer.concat([Buffer.from([blocks.length]), ...blocks]));

    expect(await client.read(1)).toEqual(Buffer.from([0x01]));
    await expectLoginAndInitialState(client);
    client.close();
  });
});
