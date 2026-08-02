import { Client as SSHClient, type ClientChannel } from "ssh2";
import net from "net";
import { EventEmitter } from "events";
import { logManager } from "./logs";

/**
 * TCP Tunnel via Pinggy.io SSH Reverse Tunnel
 * 
 * Cria um túnel TCP através do pinggy.io usando SSH reverso.
 * Comando SSH equivalente:
 *   ssh -p 443 -T -N -R0:localhost:4000 tcp@free.pinggy.io
 * 
 * O pinggy.io aloca uma porta pública que forwarda para localhost:4000.
 * Gratuito, sem cadastro, sem cartão de crédito.
 */

interface TunnelInfo {
  host: string;
  port: number;
}

class TCPManager extends EventEmitter {
  private sshClient: SSHClient | null = null;
  private tunnelInfo: TunnelInfo | null = null;
  private gamePort: number;
  private ready: boolean = false;
  private connectionAttempts: number = 0;
  private maxRetries: number = 3;
  private retryDelay: number = 10000;
  private isConnecting: boolean = false;

  constructor(gamePort: number = 4000) {
    super();
    this.gamePort = gamePort;
  }

  async start(): Promise<TunnelInfo | null> {
    logManager.addLog("[TUNNEL] Iniciando túnel TCP via pinggy.io...");
    return this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<TunnelInfo | null> {
    this.isConnecting = true;
    
    while (true) {
      this.connectionAttempts++;
      logManager.addLog(`[TUNNEL] Tentativa ${this.connectionAttempts}...`);
      
      try {
        const info = await this.connectSSH();
        if (info) {
          this.tunnelInfo = info;
          this.ready = true;
          this.emit("ready", info);
          logManager.addLog(`[TUNNEL] Túnel ativo: ${info.host}:${info.port}`);
          this.isConnecting = false;
          this.connectionAttempts = 0; // Reset counter on success
          return info;
        }
      } catch (error) {
        logManager.addLog(`[TUNNEL] Erro na tentativa ${this.connectionAttempts}: ${(error as Error).message}`);
      }

      const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 60000); // Exponential backoff up to 60s
      logManager.addLog(`[TUNNEL] Aguardando ${delay / 1000}s para próxima tentativa...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  private connectSSH(): Promise<TunnelInfo | null> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let resolvedPort: number | null = null;

      const resolveSafe = (info: TunnelInfo | null) => {
        if (!resolved) {
          resolved = true;
          resolve(info);
        }
      };

      this.sshClient = new SSHClient();

      // Quando o SSH está pronto, configurar reverse forwarding
      this.sshClient.on("ready", () => {
        logManager.addLog("[TUNNEL] SSH conectado ao pinggy.io!");

        // Verificar se o servidor de jogo já está rodando
        const testSocket = new net.Socket();
        testSocket.connect(this.gamePort, "127.0.0.1", () => {
          testSocket.destroy();
          logManager.addLog(`[TUNNEL] Servidor de jogo confirmado na porta ${this.gamePort}`);
        });
        testSocket.on("error", () => {
          logManager.addLog(`[TUNNEL] AVISO: Servidor de jogo pode não estar rodando na porta ${this.gamePort}`);
        });

        // Configurar reverse forwarding: porta remota 0 = pinggy escolhe
        this.sshClient!.forwardIn("0.0.0.0", 0, (err, port) => {
          if (err) {
            logManager.addLog(`[TUNNEL] Erro forwardIn: ${err.message}`);
            resolveSafe(null);
            return;
          }
          
          resolvedPort = port;
          logManager.addLog(`[TUNNEL] Porta remota alocada: ${port}`);
          
          // O pinggy.io retorna o host e porta via forwardIn callback
          // A URL do túnel será: free.pinggy.io:PORT
          resolveSafe({
            host: "free.pinggy.io",
            port: port,
          });
        });
      });

      // Quando o pinggy.io recebe uma conexão TCP, forwarda para nós
      this.sshClient.on("tcp connection", (info, accept, reject) => {
        logManager.addLog(`[TUNNEL] Conexão recebida via túnel de ${info.srcAddr}:${info.srcPort}`);
        
        const stream = accept();
        
        // Conectar ao servidor de jogo local
        const localSocket = new net.Socket();
        
        localSocket.connect(this.gamePort, "127.0.0.1", () => {
          logManager.addLog(`[TUNNEL] Forward para jogo local: ${this.gamePort}`);
          stream.pipe(localSocket).pipe(stream);
        });

        localSocket.on("error", (err: Error) => {
          logManager.addLog(`[TUNNEL] Erro conexão local: ${err.message}`);
          stream?.destroy();
          localSocket.destroy();
        });

        stream.on("error", (err: Error) => {
          logManager.addLog(`[TUNNEL] Erro stream túnel: ${err.message}`);
          localSocket.destroy();
        });

        localSocket.on("close", () => {
          stream?.destroy();
        });

        stream.on("close", () => {
          localSocket.destroy();
        });
      });

      this.sshClient.on("error", (err) => {
        logManager.addLog(`[TUNNEL] Erro SSH: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.sshClient.on("close", () => {
        logManager.addLog("[TUNNEL] Conexão SSH fechada pelo servidor");
        this.ready = false;
        this.tunnelInfo = null;
        
        // Tentar reconectar automaticamente
        if (!this.isConnecting) {
          logManager.addLog("[TUNNEL] Reiniciando processo de conexão...");
          this.connectWithRetry().then((info) => {
            if (info) {
              logManager.addLog("[TUNNEL] Reconectado com sucesso!");
            }
          });
        }
      });

      // Conectar ao pinggy.io via SSH na porta 443
      // Pinggy.io requer password "0000" para free tier com auth keyword
      this.sshClient.connect({
        host: "free.pinggy.io",
        port: 443,
        username: "auth",
        password: "0000",
        readyTimeout: 15000,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        // Não verificar host key (pinggy é dinâmico)
        hostHash: "sha256",
        hostVerifier: () => true,
      });

      // Timeout para a conexão SSH
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logManager.addLog("[TUNNEL] Timeout SSH (20s)");
          this.sshClient?.end();
          resolve(null);
        }
      }, 25000);
    });
  }

  getTunnelInfo(): TunnelInfo | null {
    return this.tunnelInfo;
  }

  isReady(): boolean {
    return this.ready && this.tunnelInfo !== null;
  }

  stop(): void {
    this.isConnecting = false;
    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }
    this.tunnelInfo = null;
    this.ready = false;
  }
}

export { TCPManager, type TunnelInfo };
