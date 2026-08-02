import net from "net";
import { logManager } from "./logs";

/**
 * Rucoy Game Server - Servidor TCP integrado ao backend Node.js
 * Escuta conexões dos clientes do jogo na porta 4000
 * Todos os logs são enviados automaticamente para o dashboard via WebSocket
 * 
 * Filtra conexões HTTP (health checks do Render) para não poluir os logs.
 */

const GAME_PORT = parseInt(process.env.GAME_PORT || "4000");

// Prefixos HTTP que indicam health checks ou requisições web
const HTTP_METHODS = ["GET ", "HEAD ", "POST ", "PUT ", "DELETE ", "OPTIONS ", "PATCH ", "CONNECT "];

function isHttpRequest(data: Buffer): boolean {
  const text = data.toString("ascii", 0, Math.min(data.length, 8)).toUpperCase();
  return HTTP_METHODS.some(method => text.startsWith(method));
}

interface ClientState {
  buffer: Buffer;
  address: string;
  connectedAt: Date;
  isHttp: boolean;
  handshakeSent: boolean;
  handshakeCompleted: boolean;
}

function handleClient(socket: net.Socket): void {
  const address = `${socket.remoteAddress}:${socket.remotePort}`;
  const clientState: ClientState = {
    buffer: Buffer.alloc(0),
    address,
    connectedAt: new Date(),
    isHttp: false,
    handshakeSent: false,
    handshakeCompleted: false,
  };

  // Rucoy Handshake: O servidor deve enviar 135 bytes assim que o cliente conecta
  setTimeout(() => {
    if (!clientState.isHttp && !clientState.handshakeSent) {
      sendHandshake(socket, clientState);
    }
  }, 100);

  socket.on("data", (data: Buffer) => {
    // Acumular dados recebidos
    clientState.buffer = Buffer.concat([clientState.buffer, data]);

    // Verificar se é uma requisição HTTP (health check do Render)
    if (!clientState.isHttp && isHttpRequest(data)) {
      clientState.isHttp = true;
      socket.end();
      return;
    }

    if (clientState.isHttp) return;

    // Log de dados reais do jogo
    const hex = data.toString("hex");
    const size = data.length;
    logManager.addLog(`[GAME] Recebido de ${address} (${size} bytes): ${hex}`);

    // Processar protocolo
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

function sendHandshake(socket: net.Socket, clientState: ClientState): void {
  // De acordo com engenharia reversa, o servidor envia 135 bytes
  // TODO: Substituir pelos bytes reais do servidor oficial se necessário
  const handshake = Buffer.alloc(135, 0);
  
  // Alguns servidores Rucoy antigos usavam os primeiros bytes para versão/status
  handshake[0] = 0x00;
  handshake[1] = 0x00;
  handshake[2] = 0x84; // 132 em hex (excluindo header de 3 bytes)
  
  logManager.addLog(`[GAME] Enviando handshake (135 bytes) para ${clientState.address}`);
  socket.write(handshake);
  clientState.handshakeSent = true;
}

function processGameData(socket: net.Socket, clientState: ClientState): void {
  // Se recebemos 259 bytes, é provavelmente a resposta do handshake
  if (!clientState.handshakeCompleted && clientState.buffer.length >= 259) {
    const response = clientState.buffer.subarray(0, 259);
    clientState.buffer = clientState.buffer.subarray(259);
    
    logManager.addLog(`[GAME] Handshake recebido de ${clientState.address} (259 bytes)`);
    clientState.handshakeCompleted = true;
    
    // Responder com sucesso de login (Placeholder)
    // TODO: Implementar troca de chaves RSA e validação de token
    const loginSuccess = Buffer.from("00000201", "hex"); // Exemplo de pacote de sucesso
    socket.write(loginSuccess);
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
