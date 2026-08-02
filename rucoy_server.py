import socket
import threading
import requests
import time
from datetime import datetime

# URL do backend Node.js
BACKEND_URL = "http://localhost:3000/api/log"

def send_log_to_backend(message: str):
    """Enviar log ao backend Node.js"""
    try:
        timestamp = datetime.now().isoformat()
        payload = {
            "message": message,
            "timestamp": timestamp,
            "source": "rucoy_server"
        }
        requests.post(BACKEND_URL, json=payload, timeout=2)
    except Exception as e:
        print(f"[!] Erro ao enviar log ao backend: {e}")

def handle_client(client_socket, address):
    log_msg = f"[+] Nova conexão de {address}"
    print(log_msg)
    send_log_to_backend(log_msg)
    
    try:
        while True:
            data = client_socket.recv(4096)
            if not data:
                break
            
            log_msg = f"[*] Recebido de {address}: {data.hex()}"
            print(log_msg)
            send_log_to_backend(log_msg)
            
            # Aqui entrará a lógica de resposta do protocolo
            # Como não temos o handshake ainda, vamos apenas logar
            
    except Exception as e:
        log_msg = f"[!] Erro com {address}: {e}"
        print(log_msg)
        send_log_to_backend(log_msg)
    finally:
        client_socket.close()
        log_msg = f"[-] Conexão encerrada com {address}"
        print(log_msg)
        send_log_to_backend(log_msg)

def start_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 4000))
    server.listen(5)
    
    log_msg = "[*] Servidor Rucoy Privado ouvindo na porta 4000..."
    print(log_msg)
    send_log_to_backend(log_msg)
    
    try:
        while True:
            client, addr = server.accept()
            client_handler = threading.Thread(target=handle_client, args=(client, addr))
            client_handler.daemon = True
            client_handler.start()
    except KeyboardInterrupt:
        log_msg = "\n[!] Desligando servidor..."
        print(log_msg)
        send_log_to_backend(log_msg)
    finally:
        server.close()

if __name__ == "__main__":
    start_server()
