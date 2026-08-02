import net from "net";
import crypto from "node:crypto";
import { logManager } from "./logs";

/**
 * Rucoy Game Server - Servidor TCP integrado ao backend Node.js
 * Escuta conexões dos clientes do jogo na porta 4000
 * Implementa o protocolo de handshake RSA para evitar o erro "check internet connection"
 */

const GAME_PORT = parseInt(process.env.GAME_PORT || "4000");

// Prefixos HTTP que indicam health checks ou requisições web
const HTTP_METHODS = ["GET ", "HEAD ", "POST ", "PUT ", "DELETE ", "OPTIONS ", "PATCH ", "CONNECT "];

function isHttpRequest(data: Buffer): boolean {
  const text = data.toString("ascii", 0, Math.min(data.length, 8)).toUpperCase();
  return HTTP_METHODS.some(method => text.startsWith(method));
}

enum HandshakePhase {
  VERSION_CHECK,
  RSA_KEY_EXCHANGE,
  SECRET_EXCHANGE,
  AUTHENTICATION,
  COMPLETED
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

// Chave RSA do Servidor (2048 bits para gerar blocos de 256 bytes)
const serverKeyPair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537,
});

function handleClient(socket: net.Socket): void {
  const address = `${socket.remoteAddress}:${socket.remotePort}`;
  const clientState: ClientState = {
    buffer: Buffer.alloc(0),
    address,
    connectedAt: new Date(),
    isHttp: false,
    phase: HandshakePhase.VERSION_CHECK,
    serverSecret: crypto.randomBytes(8),
  };

  // Iniciar handshake enviando a versão
  const versionPacket = Buffer.alloc(4);
  versionPacket.writeInt32BE(25); // Versão 25 esperada pelo APK
  socket.write(versionPacket);
  logManager.addLog(`[GAME] [${address}] Enviado Versão 25`);

  // Próximo passo: Enviar chave pública do servidor
  const modulus = serverKeyPair.publicKey.export({ format: "jwk" }).n;
  if (!modulus) return;
  const modulusBuf = Buffer.from(modulus, "base64url");
  const exponentBuf = Buffer.alloc(4);
  exponentBuf.writeInt32BE(65537);

  const keyPacket = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x04]), // Header: 260 bytes payload (256 modulus + 4 exponent)
    modulusBuf,
    exponentBuf
  ]);
  
  socket.write(keyPacket);
  clientState.phase = HandshakePhase.RSA_KEY_EXCHANGE;
  logManager.addLog(`[GAME] [${address}] Enviado Chave RSA Servidor (263 bytes)`);

  socket.on("data", (data: Buffer) => {
    clientState.buffer = Buffer.concat([clientState.buffer, data]);

    if (!clientState.isHttp && isHttpRequest(data)) {
      clientState.isHttp = true;
      socket.end();
      return;
    }

    if (clientState.isHttp) return;
    processGameData(socket, clientState);
  });

  socket.on("error", (error: Error) => {
    if (!clientState.isHttp) {
      logManager.addLog(`[GAME] Erro de ${address}: ${error.message}`);
    }
  });

  socket.on("close", () => {
    // Não logar desconexão de health checks HTTP
    if (clientState.isHttp) {
      return;
    }
    const uptime = Math.floor((Date.now() - clientState.connectedAt.getTime()) / 1000);
    logManager.addLog(`[GAME] Conexão encerrada: ${address} (uptime: ${uptime}s)`);
  });
}

function processGameData(socket: net.Socket, clientState: ClientState): void {
  const address = clientState.address;

  // 1. Receber Chave Pública do Cliente (135 bytes: 3 header + 128 modulus + 4 exponent)
  if (clientState.phase === HandshakePhase.RSA_KEY_EXCHANGE && clientState.buffer.length >= 135) {
    const payload = clientState.buffer.subarray(3, 135);
    clientState.buffer = clientState.buffer.subarray(135);

    const modulus = payload.subarray(0, 128);
    const exponent = payload.readInt32BE(128);

    // Importar chave do cliente
    clientState.clientPublicKey = crypto.createPublicKey({
      key: {
        kty: "RSA",
        n: modulus.toString("base64url"),
        e: Buffer.from([0, exponent >> 16, exponent >> 8, exponent & 0xFF]).toString("base64url"),
      },
      format: "jwk",
    });

    logManager.addLog(`[GAME] [${address}] Recebida Chave RSA Cliente (1024 bits)`);

    // Enviar Segredo do Servidor (criptografado com a chave do cliente)
    const encryptedSecret = crypto.publicEncrypt(
      { key: clientState.clientPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      clientState.serverSecret
    );
    
    const secretPacket = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x80]), // Header 128 bytes
      encryptedSecret
    ]);
    
    socket.write(secretPacket);
    clientState.phase = HandshakePhase.SECRET_EXCHANGE;
    logManager.addLog(`[GAME] [${address}] Enviado Segredo Servidor`);
  }

  // 2. Receber Segredo do Cliente (259 bytes: 3 header + 256 bytes encrypted)
  if (clientState.phase === HandshakePhase.SECRET_EXCHANGE && clientState.buffer.length >= 259) {
    const encrypted = clientState.buffer.subarray(3, 259);
    clientState.buffer = clientState.buffer.subarray(259);

    clientState.clientSecret = crypto.privateDecrypt(
      { key: serverKeyPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      encrypted
    );

    logManager.addLog(`[GAME] [${address}] Recebido Segredo Cliente`);
    clientState.phase = HandshakePhase.AUTHENTICATION;
  }

  // 3. Receber Autenticação (259 bytes: 3 header + 256 bytes encrypted [ServerSecret + Token])
  if (clientState.phase === HandshakePhase.AUTHENTICATION && clientState.buffer.length >= 259) {
    const encrypted = clientState.buffer.subarray(3, 259);
    clientState.buffer = clientState.buffer.subarray(259);

    const decrypted = crypto.privateDecrypt(
      { key: serverKeyPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      encrypted
    );

    // Verificar se o ServerSecret bate
    const receivedServerSecret = decrypted.subarray(0, 8);
    if (receivedServerSecret.equals(clientState.serverSecret)) {
      logManager.addLog(`[GAME] [${address}] Autenticação validada com sucesso!`);
      
      // Enviar Confirmação de Login
      // Payload: ClientSecret (8) + SuccessByte (1) + Token (12) = 21 bytes
      const successPayload = Buffer.alloc(128, 0);
      clientState.clientSecret!.copy(successPayload, 0);
      successPayload[8] = 0x01; // Success
      Buffer.from("manus_server").copy(successPayload, 9); // Token fake

      const encryptedSuccess = crypto.publicEncrypt(
        { key: clientState.clientPublicKey!, padding: crypto.constants.RSA_PKCS1_PADDING },
        successPayload
      );

      socket.write(Buffer.concat([Buffer.from([0x00, 0x00, 0x80]), encryptedSuccess]));
      clientState.phase = HandshakePhase.COMPLETED;
      logManager.addLog(`[GAME] [${address}] Login finalizado. Entrando no mundo...`);
      
      // Enviar pacote para mudar estado para 'In Game' (s=5)
      // Baseado em com/mmo/c/c.smali, precisamos enviar um pacote que mude s para 5.
      // Exemplo: 00 01 01 (opcode 1, sub-opcode 1) - Ajustar conforme necessário
      socket.write(Buffer.from("000101", "hex"));
    } else {
      logManager.addLog(`[GAME] [${address}] Erro: Segredo do servidor inválido na autenticação`);
      socket.end();
    }
  }
}

function startGameServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleClient(socket);
    });

    server.on("error", (error) => {
      logManager.addLog(`[GAME] Erro no servidor de jogo: ${error.message}`);
    });

    server.listen(GAME_PORT, () => {
      logManager.addLog(`[GAME] Servidor de jogo Rucoy rodando na porta ${GAME_PORT}`);
      resolve();
    });
  });
}

export { startGameServer };
