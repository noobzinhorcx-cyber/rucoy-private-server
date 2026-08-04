import net from "net";
import crypto from "node:crypto";
import { logManager } from "./logs";

/**
 * Rucoy Game Server - Servidor TCP integrado ao backend Node.js
 *
 * A implementação abaixo segue exatamente o código do cliente (APK 1.14.2):
 *   - com/mmo/e/j.b(SocketChannel)  -> leitura da versão (4 bytes, int BE)
 *   - com/mmo/c/a.a(SocketChannel)  -> handshake RSA
 *   - com/mmo/c/a.b(SocketChannel)  -> resposta de login
 *   - com/mmo/c/c.a()               -> dispatch de opcodes do servidor
 *   - com/mmo/c/b.h()               -> pacotes do cliente (prefixados por 2 bytes)
 *
 * Sequência do handshake (inteiros em Big Endian):
 *   S -> C   4   bytes  versão do protocolo (25); != 25 => "Different game version"
 *   S -> C   132 bytes  chave pública do servidor (128 modulus + 4 exponent)
 *   C -> S   133 bytes  chave pública do cliente (BigInteger.toByteArray = 129 + 4)
 *   S -> C   128 bytes  ServerSecret (long de 8 bytes) cifrado com a chave do cliente
 *   C -> S   128 bytes  ClientSecret (long de 8 bytes) cifrado com a chave do servidor
 *   C -> S   128 bytes  login local: cifrado de [long ServerSecret][token]
 *            ou, no fluxo Google, [byte N][N blocos de 128 bytes] do id token, que é
 *            respondido com 1 byte (1 = OK) e substitui o bloco de login local.
 *   S -> C   128 bytes  cifrado de [long ClientSecret][byte 1][12 bytes token]
 *
 * IMPORTANTE: pacotes servidor -> cliente NÃO têm prefixo de tamanho. O cliente lê
 * um byte de opcode direto do stream (com/mmo/c/c.a) e usa BufferUnderflowException
 * + compact() para lidar com pacotes parciais. Apenas cliente -> servidor é
 * prefixado por 2 bytes de tamanho.
 */

const GAME_PORT = parseInt(process.env.GAME_PORT || "4000");

const PROTOCOL_VERSION = 25;
const RSA_MODULUS_BYTES = 128;
const RSA_EXPONENT_BYTES = 4;
const SERVER_KEY_PACKET_SIZE = RSA_MODULUS_BYTES + RSA_EXPONENT_BYTES; // 132
const CLIENT_KEY_PACKET_SIZE = RSA_MODULUS_BYTES + 1 + RSA_EXPONENT_BYTES; // 133
const RSA_BLOCK_SIZE = 128;
const SECRET_SIZE = 8;
const LOGIN_TOKEN_SIZE = 12;
const MAX_GOOGLE_TOKEN_BLOCKS = 64;

/**
 * Opcodes servidor -> cliente (com/mmo/c/c.a).
 * 0x00 = atualização de criaturas, 0x01 = remover criatura,
 * 0x02 = define a criatura local (com/mmo/b/b.b), 0x18 = HP/Mana + entra no jogo (s=5).
 */
const OP_SET_LOCAL_PLAYER = 0x02;
const OP_PLAYER_STATUS = 0x18;

// Valores iniciais do personagem
const PLAYER_ID = 12345;
const PLAYER_HP = 1000;
const PLAYER_MAX_HP = 1000;
const PLAYER_MANA = 500;
const PLAYER_MAX_MANA = 500;
// O cliente lê exatamente 12 bytes de token quando o status de login é 1
const LOGIN_TOKEN = "RUCOYPRIV001";

// Prefixos HTTP que indicam health checks ou requisições web
const HTTP_METHODS = [
  "GET ",
  "HEAD ",
  "POST ",
  "PUT ",
  "DELETE ",
  "OPTIONS ",
  "PATCH ",
  "CONNECT ",
];

function isHttpRequest(data: Buffer): boolean {
  const text = data
    .toString("ascii", 0, Math.min(data.length, 8))
    .toUpperCase();
  return HTTP_METHODS.some(method => text.startsWith(method));
}

function log(address: string, message: string): void {
  const entry = `[GAME] [${address}] ${message}`;
  console.log(entry);
  logManager.addLog(entry);
}

function hex(data: Buffer, maxBytes = 64): string {
  const grouped = data
    .subarray(0, maxBytes)
    .toString("hex")
    .toUpperCase()
    .replace(/(..)/g, "$1 ")
    .trim();
  return data.length > maxBytes
    ? `${grouped} ... (+${data.length - maxBytes} bytes)`
    : grouped;
}

enum HandshakePhase {
  CLIENT_PUBLIC_KEY,
  CLIENT_SECRET,
  LOGIN,
  IN_GAME,
}

interface ClientState {
  buffer: Buffer;
  address: string;
  connectedAt: Date;
  isHttp: boolean;
  phase: HandshakePhase;
  serverSecret: Buffer;
  clientSecret?: Buffer;
  clientPublicKey?: crypto.KeyObject;
}

// Chave RSA do servidor: 1024 bits, mesmo tamanho usado pelo cliente
const serverKeyPair = crypto.generateKeyPairSync("rsa", {
  modulusLength: RSA_MODULUS_BYTES * 8,
  publicExponent: 65537,
});

/** Modulus do servidor com exatamente 128 bytes (o cliente lê new BigInteger(1, byte[128])). */
function serverModulus(): Buffer {
  const jwk = serverKeyPair.publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.n!, "base64url");
  if (raw.length === RSA_MODULUS_BYTES) return raw;
  if (raw.length > RSA_MODULUS_BYTES)
    return raw.subarray(raw.length - RSA_MODULUS_BYTES);
  return Buffer.concat([Buffer.alloc(RSA_MODULUS_BYTES - raw.length, 0), raw]);
}

function send(
  socket: net.Socket,
  state: ClientState,
  label: string,
  data: Buffer
): void {
  socket.write(data);
  log(state.address, `--> ${label} (${data.length} bytes): ${hex(data)}`);
}

function encryptForClient(state: ClientState, data: Buffer): Buffer {
  return crypto.publicEncrypt(
    {
      key: state.clientPublicKey!,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    data
  );
}

/**
 * Decifra um bloco RSA/ECB/PKCS1Padding com a chave privada do servidor.
 *
 * O Node 18+ recusa RSA_PKCS1_PADDING em privateDecrypt (CVE-2023-46809), então
 * deciframos sem padding e removemos o envelope PKCS#1 v1.5 (00 02 PS 00 M)
 * manualmente, em vez de depender da flag --security-revert.
 */
function decryptFromClient(data: Buffer): Buffer {
  const raw = crypto.privateDecrypt(
    { key: serverKeyPair.privateKey, padding: crypto.constants.RSA_NO_PADDING },
    data
  );
  if (raw.length < 11 || raw[0] !== 0x00 || raw[1] !== 0x02) {
    throw new Error(`envelope PKCS#1 inválido (${hex(raw.subarray(0, 2))})`);
  }
  const separator = raw.indexOf(0x00, 2);
  if (separator < 0) throw new Error("envelope PKCS#1 sem separador");
  return raw.subarray(separator + 1);
}

function handleClient(socket: net.Socket): void {
  const address = `${socket.remoteAddress}:${socket.remotePort}`;
  const state: ClientState = {
    buffer: Buffer.alloc(0),
    address,
    connectedAt: new Date(),
    isHttp: false,
    phase: HandshakePhase.CLIENT_PUBLIC_KEY,
    serverSecret: crypto.randomBytes(SECRET_SIZE),
  };

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);

  log(address, "Nova conexão TCP");

  // 1. Versão do protocolo (4 bytes) - com/mmo/e/j.b
  const versionPacket = Buffer.alloc(4);
  versionPacket.writeInt32BE(PROTOCOL_VERSION, 0);
  send(socket, state, `Versão ${PROTOCOL_VERSION}`, versionPacket);

  // 2. Chave pública do servidor (132 bytes: 128 modulus + 4 exponent)
  const exponent = Buffer.alloc(RSA_EXPONENT_BYTES);
  exponent.writeInt32BE(65537, 0);
  send(
    socket,
    state,
    `Chave pública do servidor (${SERVER_KEY_PACKET_SIZE} bytes)`,
    Buffer.concat([serverModulus(), exponent])
  );

  socket.on("data", (data: Buffer) => {
    if (!state.isHttp && state.buffer.length === 0 && isHttpRequest(data)) {
      state.isHttp = true;
      socket.end();
      return;
    }
    if (state.isHttp) return;

    log(address, `<-- Recebido (${data.length} bytes): ${hex(data)}`);
    state.buffer = Buffer.concat([state.buffer, data]);
    processGameData(socket, state);
  });

  socket.on("error", (error: Error) => {
    if (!state.isHttp) log(address, `Erro de socket: ${error.message}`);
  });

  socket.on("close", hadError => {
    if (state.isHttp) return;
    const uptime = Math.floor(
      (Date.now() - state.connectedAt.getTime()) / 1000
    );
    log(
      address,
      `Conexão encerrada (fase=${HandshakePhase[state.phase]}, erro=${hadError}, uptime=${uptime}s)`
    );
  });
}

function processGameData(socket: net.Socket, state: ClientState): void {
  try {
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (state.phase === HandshakePhase.CLIENT_PUBLIC_KEY)
        progressed = readClientPublicKey(socket, state);
      else if (state.phase === HandshakePhase.CLIENT_SECRET)
        progressed = readClientSecret(state);
      else if (state.phase === HandshakePhase.LOGIN)
        progressed = readLogin(socket, state);
      else if (state.phase === HandshakePhase.IN_GAME)
        progressed = readGamePacket(state);
    }
  } catch (error) {
    log(state.address, `Erro ao processar dados: ${(error as Error).message}`);
    socket.end();
  }
}

/** C -> S: 133 bytes (129 modulus com byte de sinal + 4 exponent), depois envia o ServerSecret. */
function readClientPublicKey(socket: net.Socket, state: ClientState): boolean {
  if (state.buffer.length < CLIENT_KEY_PACKET_SIZE) return false;

  const payload = state.buffer.subarray(0, CLIENT_KEY_PACKET_SIZE);
  state.buffer = state.buffer.subarray(CLIENT_KEY_PACKET_SIZE);

  const signed = payload.subarray(0, RSA_MODULUS_BYTES + 1);
  const modulus = signed[0] === 0 ? signed.subarray(1) : signed;
  const exponentValue = payload.readInt32BE(RSA_MODULUS_BYTES + 1);

  const exponentBytes = Buffer.alloc(RSA_EXPONENT_BYTES);
  exponentBytes.writeUInt32BE(exponentValue >>> 0, 0);
  let start = 0;
  while (start < exponentBytes.length - 1 && exponentBytes[start] === 0)
    start++;

  state.clientPublicKey = crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: modulus.toString("base64url"),
      e: exponentBytes.subarray(start).toString("base64url"),
    },
    format: "jwk",
  });

  log(
    state.address,
    `Chave pública do cliente recebida (modulus=${modulus.length}B, exponent=${exponentValue})`
  );
  log(state.address, `    modulus: ${hex(modulus)}`);
  log(state.address, `ServerSecret gerado: ${hex(state.serverSecret)}`);

  send(
    socket,
    state,
    `ServerSecret cifrado (${RSA_BLOCK_SIZE} bytes)`,
    encryptForClient(state, state.serverSecret)
  );

  state.phase = HandshakePhase.CLIENT_SECRET;
  return true;
}

/** C -> S: 128 bytes cifrados contendo o ClientSecret (long). */
function readClientSecret(state: ClientState): boolean {
  if (state.buffer.length < RSA_BLOCK_SIZE) return false;

  const encrypted = state.buffer.subarray(0, RSA_BLOCK_SIZE);
  state.buffer = state.buffer.subarray(RSA_BLOCK_SIZE);

  state.clientSecret = decryptFromClient(encrypted).subarray(0, SECRET_SIZE);
  log(state.address, `ClientSecret decifrado: ${hex(state.clientSecret)}`);

  state.phase = HandshakePhase.LOGIN;
  return true;
}

/**
 * Fase de login. Existem dois fluxos em com/mmo/c/a.a:
 *   - local  (i.d == false): 1 bloco de 128 bytes = cifrado de [long ServerSecret][token]
 *   - Google (i.d == true):  [byte N][N blocos de 128 bytes] do id token, respondido com
 *                            1 byte (0 = falha) e SEM o bloco de login local
 *
 * Os dois começam com um bloco cifrado que contém o ServerSecret, então a distinção é
 * feita pelo enquadramento: no fluxo Google o primeiro byte é a contagem de blocos e o
 * bloco cifrado só começa no offset 1.
 */
function readLogin(socket: net.Socket, state: ClientState): boolean {
  if (state.buffer.length < RSA_BLOCK_SIZE) return false;

  const blocks = state.buffer[0];
  const googleSize = 1 + blocks * RSA_BLOCK_SIZE;
  if (
    blocks >= 1 &&
    blocks <= MAX_GOOGLE_TOKEN_BLOCKS &&
    state.buffer.length >= googleSize &&
    decryptSignedBlock(state, 1) !== null
  ) {
    // com/mmo/c/a.c: id token do Google em blocos cifrados. Não validamos, apenas aceitamos.
    state.buffer = state.buffer.subarray(googleSize);
    log(state.address, `Token Google recebido (${blocks} bloco(s)), aceitando`);
    send(socket, state, "Google sign-in OK", Buffer.from([0x01]));
    completeLogin(socket, state);
    return true;
  }

  const localLogin = decryptSignedBlock(state, 0);
  if (localLogin) {
    state.buffer = state.buffer.subarray(RSA_BLOCK_SIZE);
    log(
      state.address,
      `Login local recebido: ServerSecret confirmado, token="${localLogin.subarray(SECRET_SIZE).toString("utf8")}"`
    );
    completeLogin(socket, state);
    return true;
  }

  if (state.buffer.length > 1 + MAX_GOOGLE_TOKEN_BLOCKS * RSA_BLOCK_SIZE) {
    throw new Error(
      `pacote de login não reconhecido (${state.buffer.length} bytes)`
    );
  }
  return false;
}

/**
 * Decifra o bloco de 128 bytes em `offset` e o devolve caso comece com o ServerSecret,
 * que o cliente prefixa em todo bloco assinado (com/mmo/c/a.a(byte[])).
 */
function decryptSignedBlock(state: ClientState, offset: number): Buffer | null {
  if (state.buffer.length < offset + RSA_BLOCK_SIZE) return null;
  try {
    const decrypted = decryptFromClient(
      state.buffer.subarray(offset, offset + RSA_BLOCK_SIZE)
    );
    return decrypted.subarray(0, SECRET_SIZE).equals(state.serverSecret)
      ? decrypted
      : null;
  } catch {
    return null;
  }
}

function completeLogin(socket: net.Socket, state: ClientState): void {
  // com/mmo/c/a.b espera [long ClientSecret][byte status=1][12 bytes token]
  const response = Buffer.alloc(SECRET_SIZE + 1 + LOGIN_TOKEN_SIZE);
  state.clientSecret!.copy(response, 0);
  response[SECRET_SIZE] = 0x01;
  Buffer.from(LOGIN_TOKEN, "ascii").copy(response, SECRET_SIZE + 1);
  log(state.address, `Resposta de login (plano): ${hex(response)}`);
  send(
    socket,
    state,
    `Login OK cifrado (${RSA_BLOCK_SIZE} bytes)`,
    encryptForClient(state, response)
  );

  state.phase = HandshakePhase.IN_GAME;
  log(state.address, "Handshake concluído. Enviando estado inicial do jogo...");
  sendInitialState(socket, state);
}

/** Opcodes que criam a criatura local e colocam o cliente em jogo (com.mmo.a.s = 5). */
function sendInitialState(socket: net.Socket, state: ClientState): void {
  const playerId = Buffer.alloc(1 + 4);
  playerId[0] = OP_SET_LOCAL_PLAYER;
  playerId.writeInt32BE(PLAYER_ID, 1);
  send(
    socket,
    state,
    `Opcode 0x02 SET_LOCAL_PLAYER (id=${PLAYER_ID})`,
    playerId
  );

  const status = Buffer.alloc(1 + 16);
  status[0] = OP_PLAYER_STATUS;
  status.writeInt32BE(PLAYER_HP, 1);
  status.writeInt32BE(PLAYER_MAX_HP, 5);
  status.writeInt32BE(PLAYER_MANA, 9);
  status.writeInt32BE(PLAYER_MAX_MANA, 13);
  send(
    socket,
    state,
    `Opcode 0x18 PLAYER_STATUS (hp=${PLAYER_HP}/${PLAYER_MAX_HP}, mana=${PLAYER_MANA}/${PLAYER_MAX_MANA})`,
    status
  );
}

/** Pacotes do cliente: [2 bytes tamanho][corpo com um ou mais opcodes] (com/mmo/c/b.h). */
function readGamePacket(state: ClientState): boolean {
  if (state.buffer.length < 2) return false;

  const length = state.buffer.readUInt16BE(0);
  if (state.buffer.length < 2 + length) return false;

  const body = state.buffer.subarray(2, 2 + length);
  state.buffer = state.buffer.subarray(2 + length);
  const opcode =
    length > 0 ? `0x${body[0].toString(16).padStart(2, "0")}` : "vazio";
  log(
    state.address,
    `Pacote do cliente opcode=${opcode} (${length} bytes): ${hex(body)}`
  );
  return true;
}

function startGameServer(): Promise<void> {
  return new Promise(resolve => {
    const server = net.createServer(handleClient);

    server.on("error", error => {
      const entry = `[GAME] Erro no servidor de jogo: ${error.message}`;
      console.error(entry);
      logManager.addLog(entry);
    });

    server.listen(GAME_PORT, () => {
      const entry = `[GAME] Servidor de jogo Rucoy rodando na porta ${GAME_PORT}`;
      console.log(entry);
      logManager.addLog(entry);
      resolve();
    });
  });
}

export { startGameServer };
