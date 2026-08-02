import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { logManager } from "../logs";
import { WebSocketServer, type WebSocket } from "ws";
import type { LogPayload } from "../routers";
import { startGameServer } from "../gameServer";
import { TCPManager } from "../tunnel";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  
  // WebSocket para logs em tempo real
  const wss = new WebSocketServer({ server, path: "/api/logs" });
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  
  // Endpoint para receber logs do rucoy_server.py
  app.post("/api/log", (req, res) => {
    const payload = req.body as LogPayload;
    if (payload.message) {
      const logEntry = payload.source ? `[${payload.source}] ${payload.message}` : payload.message;
      logManager.addLog(logEntry);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "message é obrigatório" });
    }
  });
  
  // Iniciar túnel TCP via pinggy.io (SSH reverso)
  const GAME_PORT = parseInt(process.env.GAME_PORT || "4000");
  const tcpManager = new TCPManager(GAME_PORT);
  
  logManager.addLog("[TUNNEL] Iniciando túnel TCP via pinggy.io...");
  const tunnelInfo = await tcpManager.start();
  
  if (tunnelInfo) {
    logManager.addLog(`[TUNNEL] Túnel criado com sucesso: ${tunnelInfo.host}:${tunnelInfo.port}`);
    // Atualizar server_list.json com o endereço do túnel
    logManager.updateServerAddress(tunnelInfo.host, tunnelInfo.port);
  } else {
    logManager.addLog("[TUNNEL] Falha ao criar túnel, usando localhost como fallback");
  }
  
  // Endpoint para lista de servidores (compatível com Rucoy Online)
  app.get("/server_list.json", (req, res) => {
    res.json({
      servers: logManager.getServers(),
      timestamp: new Date().toISOString(),
    });
  });
  
  // WebSocket handler para enviar logs
  wss.on("connection", (ws: WebSocket) => {
    logManager.addLog("[WS] Cliente conectado");
    
    // Enviar logs anteriores
    logManager.getLogs().forEach((log) => {
      ws.send(log);
    });
    
    // Listener para novos logs
    const logListener = (log: string) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(log);
      }
    };
    
    logManager.on("log", logListener);
    
    ws.on("close", () => {
      logManager.removeListener("log", logListener);
      logManager.addLog("[WS] Cliente desconectado");
    });
    
    ws.on("error", (error: Error) => {
      logManager.addLog(`[WS] Erro: ${error.message}`);
    });
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  
  // Log inicial
  logManager.addLog("[SERVER] Servidor iniciado");
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    logManager.addLog(`[SERVER] Ouvindo na porta ${port}`);

    // Iniciar o servidor de jogo TCP (Rucoy)
    startGameServer().catch((error) => {
      logManager.addLog(`[GAME] Falha ao iniciar servidor de jogo: ${error.message}`);
    });
    
    // Armazenar referência do tcpManager para cleanup
    (globalThis as any).__tcpManager = tcpManager;
  });
}

startServer().catch((error) => {
  console.error(error);
  logManager.addLog(`[ERROR] Falha ao iniciar servidor: ${error.message}`);
});
