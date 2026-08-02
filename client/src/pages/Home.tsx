import { useEffect, useRef, useState } from "react";

declare const __WS_URL__: string;

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Conectar ao WebSocket para receber logs em tempo real
    const wsUrl = __WS_URL__ || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
    const ws = new WebSocket(`${wsUrl}/api/logs`);

    ws.onmessage = (event) => {
      const log = event.data;
      setLogs((prev) => [...prev, log]);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setLogs((prev) => [...prev, "[ERRO] Falha na conexão WebSocket"]);
    };

    ws.onopen = () => {
      console.log("WebSocket conectado");
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [__WS_URL__]);

  // Auto-scroll para o final dos logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div style={{ backgroundColor: "white", minHeight: "100vh", padding: "10px", fontFamily: "monospace", fontSize: "12px", overflow: "auto", lineHeight: "1.5" }}>
      {logs.length === 0 && <div style={{ color: "#999" }}>Aguardando logs...</div>}
      {logs.map((log, index) => (
        <div key={index} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{log}</div>
      ))}
      <div ref={logsEndRef} />
    </div>
  );
}
