import net from "net";
import { logManager } from "./logs";

/**
 * Rucoy Game Server - Servidor TCP integrado ao backend Node.js
 * Escuta conexões dos clientes do jogo na porta 4000
 * Todos os logs são enviados automaticamente para o dashboard via WebSocket
 */

const GAME_PORT = parseInt(process.env.GAME_PORT || "4000");

// Buffer para dados parciais de cada conexão
interface ClientState {
  buffer: Buffer;
  address: string;
  connectedAt: Date;
}

function handleClient(socket: net.Socket): void {
  const address = `${socket.remoteAddress}:${socket.remotePort}`;
  const clientState: ClientState = {
    buffer: Buffer.alloc(0),
    address,
    connectedAt: new Date(),
  };

  logManager.addLog(`[GAME] Nova conexão: ${address}`);

  socket.on("data", (data: Buffer) => {
    // Acumular dados recebidos
    clientState.buffer = Buffer.concat([clientState.buffer, data]);

    const hex = data.toString("hex");
    const size = data.length;
    logManager.addLog(`[GAME] Dados de ${address} (${size} bytes): ${hex}`);

    // Aqui entra a lógica de processamento do protocolo Rucoy
    // Quando o handshake e protocolos forem implementados, processar aqui
    processGameData(socket, clientState);
  });

  socket.on("error", (error: Error) => {
    logManager.addLog(`[GAME] Erro de ${address}: ${error.message}`);
  });

  socket.on("close", () => {
    const uptime = Math.floor((Date.now() - clientState.connectedAt.getTime()) / 1000);
    logManager.addLog(`[GAME] Conexão encerrada: ${address} (uptime: ${uptime}s)`);
  });
}

function processGameData(socket: net.Socket, _clientState: ClientState): void {
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
