import { EventEmitter } from "events";

export interface ServerInfo {
  name: string;
  ip: string;
  port: number;
  region: string;
  version: string;
  visible: boolean;
  languages: string[];
  public_key: string;
}

class LogManager extends EventEmitter {
  private logs: string[] = [];
  private maxLogs = 1000;
  private servers: ServerInfo[] = [
    {
      name: "Rucoy Private",
      ip: "xbxrm-187-65-69-66.run.pinggy-free.link",
      port: 39031,
      region: "br",
      version: "1.25.2",
      visible: true,
      languages: ["pt", "en"],
      public_key: "rucoy_private_server_key_v1",
    },
  ];

  addLog(message: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);

    // Manter apenas os últimos N logs
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Emitir evento para WebSocket
    this.emit("log", logEntry);
  }

  getLogs(): string[] {
    return this.logs;
  }

  getServers(): ServerInfo[] {
    return this.servers;
  }

  addServer(server: ServerInfo) {
    this.servers.push(server);
    this.addLog(
      `[SERVER] Novo servidor adicionado: \( {server.name} ( \){server.ip}:${server.port})`
    );
  }

  removeServer(ip: string, port: number) {
    this.servers = this.servers.filter(
      (s) => !(s.ip === ip && s.port === port)
    );
    this.addLog(`[SERVER] Servidor removido: \( {ip}: \){port}`);
  }

  updateServerAddress(host: string, port: number) {
    if (this.servers.length > 0) {
      this.servers[0].ip = host;
      this.servers[0].port = port;
      this.addLog(
        `[SERVER] Endereço atualizado: ${this.servers[0].name} -> \( {host}: \){port}`
      );
    }
  }
}

export const logManager = new LogManager();
