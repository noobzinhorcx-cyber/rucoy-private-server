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
}

function handleClient(socket: net.Socket): void {
  const address = `${socket.remoteAddress}:${socket.remotePort}`;
  const clientState: ClientState = {
    buffer: Buffer.alloc(0),
    address,
    connectedAt: new Date(),
    isHttp: false,
  };

  socket.on("data", (data: Buffer) => {
    // Acumular dados recebidos
    clientState.buffer = Buffer.concat([clientState.buffer, data]);

    // Verificar se é uma requisição HTTP (health check do Render)
    if (!clientState.isHttp && isHttpRequest(data)) {
      clientState.isHttp = true;
      // Fechar silenciosamente — é apenas o health check do Render
      socket.end();
      return;
    }

    // Se já identificou como HTTP, ignorar o resto
    if (clientState.isHttp) {
      return;
    }

    // Log de dados reais do jogo
    const hex = data.toString("hex");
    const size = data.length;
    logManager.addLog(`[GAME] Dados de ${address} (${size} bytes): ${hex}`);

    // Aqui entra a lógica de processamento do protocolo Rucoy
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

function processGameData(_socket: net.Socket, _clientState: ClientState): void {
  // Placeholder para processamento do protocolo Rucoy
  // Por enquanto, apenas confirmamos recebimento
  // TODO: Implementar handshake, movimento, chat, etc.
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
