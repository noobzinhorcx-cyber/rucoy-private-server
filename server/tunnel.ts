import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "events";
import { logManager } from "./logs";

/**
 * TCP Tunnel via bore.pub
 * 
 * Cria um túnel TCP através do bore.pub para expor a porta do jogo (4000)
 * ao mundo externo. O Render Free Plan não permite expor portas TCP,
 * então usamos o bore.pub como proxy.
 * 
 * O bore.pub retorna uma URL como: xxx.bore.pub:PORT
 */

interface TunnelInfo {
  host: string;
  port: number;
  publicPort?: number;
}

const BORE_VERSION = "v0.5.0";

function getArch(): string {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return process.arch;
}

function getPlatform(): string {
  if (process.platform === "linux") return "x86_64-unknown-linux-musl";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  return "x86_64-unknown-linux-musl";
}

function getBoreBinaryPath(): string {
  // Usar um diretório temporário no projeto para o binário
  const binDir = path.resolve(process.cwd(), ".bore-bin");
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  return path.join(binDir, "bore");
}

async function downloadBore(): Promise<boolean> {
  const binPath = getBoreBinaryPath();
  
  if (fs.existsSync(binPath)) {
    logManager.addLog("[TUNNEL] Binário bore já existe, pulando download.");
    return true;
  }

  const platform = getPlatform();
  const ext = process.platform === "win32" ? ".exe" : "";
  const url = `https://github.com/ekzhang/bore/releases/download/${BORE_VERSION}/bore-${BORE_VERSION}-${platform}${ext}.gz`;
  
  logManager.addLog(`[TUNNEL] Baixando bore de: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logManager.addLog(`[TUNNEL] Erro ao baixar bore: HTTP ${response.status}`);
      return false;
    }

    const gzBuffer = Buffer.from(await response.arrayBuffer());
    
    // Descomprimir gzip
    const { gunzipSync } = await import("node:zlib");
    const binary = gunzipSync(gzBuffer);
    
    fs.writeFileSync(binPath, binary);
    fs.chmodSync(binPath, 0o755);
    
    logManager.addLog("[TUNNEL] Binário bore baixado com sucesso!");
    return true;
  } catch (error) {
    logManager.addLog(`[TUNNEL] Erro ao baixar bore: ${(error as Error).message}`);
    return false;
  }
}

class TCPManager extends EventEmitter {
  private tunnelProcess: ChildProcess | null = null;
  private tunnelInfo: TunnelInfo | null = null;
  private boreBinary: string;
  private gamePort: number;
  private ready: boolean = false;

  constructor(gamePort: number = 4000) {
    super();
    this.gamePort = gamePort;
    this.boreBinary = getBoreBinaryPath();
  }

  async start(): Promise<TunnelInfo | null> {
    logManager.addLog("[TUNNEL] Preparando túnel TCP via bore.pub...");
    
    // Baixar binário se necessário
    const downloaded = await downloadBore();
    if (!downloaded) {
      logManager.addLog("[TUNNEL] Falha ao baixar binário bore.");
      return null;
    }

    logManager.addLog(`[TUNNEL] Iniciando bore para porta ${this.gamePort}...`);

    const args = [
      "local",
      this.gamePort.toString(),
      "--to",
      "bore.pub",
    ];

    this.tunnelProcess = spawn(this.boreBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.tunnelProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        logManager.addLog(`[TUNNEL] ${output}`);
      }
      this.parseTunnelOutput(output);
    });

    this.tunnelProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        logManager.addLog(`[TUNNEL] ERR: ${output}`);
      }
      this.parseTunnelOutput(output);
    });

    this.tunnelProcess.on("error", (error) => {
      logManager.addLog(`[TUNNEL] Erro no processo bore: ${error.message}`);
    });

    this.tunnelProcess.on("close", (code) => {
      logManager.addLog(`[TUNNEL] Processo bore fechado com código ${code}`);
      this.ready = false;
      this.tunnelInfo = null;
    });

    // Timeout para esperar a conexão
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.tunnelInfo) {
          clearTimeout(timeout);
          this.ready = true;
          this.emit("ready", this.tunnelInfo);
          resolve(this.tunnelInfo);
        } else {
          logManager.addLog("[TUNNEL] Timeout: bore não conectou em 20s");
          resolve(null);
        }
      }, 20000);

      // Verificar periodicamente se o túnel está pronto
      const check = setInterval(() => {
        if (this.tunnelInfo) {
          clearTimeout(timeout);
          clearInterval(check);
          this.ready = true;
          this.emit("ready", this.tunnelInfo);
          resolve(this.tunnelInfo);
        }
      }, 2000);
    });
  }

  private parseTunnelOutput(output: string): void {
    // O bore retorna algo como:
    // "Listening on xxx.bore.pub:12345"
    // ou
    // "listening on bore.pub:12345"
    const match = output.match(/(?:listening\s+on\s+|Listening\s+on\s+)(\S+):(\d+)/i);
    if (match) {
      const host = match[1];
      const port = parseInt(match[2]);
      this.tunnelInfo = { host, port, publicPort: port };
      logManager.addLog(`[TUNNEL] Túnel ativo: ${host}:${port}`);
    }
  }

  getTunnelInfo(): TunnelInfo | null {
    return this.tunnelInfo;
  }

  isReady(): boolean {
    return this.ready && this.tunnelInfo !== null;
  }

  stop(): void {
    if (this.tunnelProcess) {
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.tunnelInfo = null;
    this.ready = false;
  }
}

export { TCPManager, type TunnelInfo };
