import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Conectar ao WebSocket para receber logs em tempo real
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/logs`);

    ws.onmessage = (event) => {
      const log = event.data;
      setLogs((prev) => [...prev, log]);
    };

    ws.onerror = () => {
      setLogs((prev) => [...prev, "[ERRO] Falha na conexão WebSocket"]);
    };

    return () => {
      ws.close();
    };
  }, []);

  // Auto-scroll para o final dos logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div style={{ backgroundColor: "white", minHeight: "100vh", padding: "10px", fontFamily: "monospace", fontSize: "12px", overflow: "auto" }}>
      {logs.map((log, index) => (
        <div key={index}>{log}</div>
      ))}
      <div ref={logsEndRef} />
    </div>
  );
}
