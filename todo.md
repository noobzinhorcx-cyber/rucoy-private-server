# Rucoy Private Server - TODO

## Funcionalidades Principais
- [x] Frontend minimalista com logs em tempo real
- [x] WebSocket para streaming de logs
- [x] Endpoint GET /server_list.json com formato compatível
- [x] Sistema de logs do servidor
- [ ] Integração com rucoy_server.py para capturar conexões

## Frontend
- [x] Remover todos os componentes padrão (DashboardLayout, navegação, etc)
- [x] Criar página branca simples com apenas logs
- [x] Implementar conexão WebSocket para receber logs
- [x] Exibir logs em tempo real com scroll automático

## Backend
- [x] Criar sistema de logs centralizador
- [x] Implementar endpoint /server_list.json
- [x] Integrar WebSocket para enviar logs ao frontend
- [x] Criar procedimento tRPC para obter lista de servidores

## Servidor Python
- [ ] Integrar rucoy_server.py com o backend Node.js
- [ ] Capturar logs de conexões e enviar ao frontend

## Testes
- [x] Verificar se logs aparecem em tempo real
- [x] Testar endpoint /server_list.json
- [x] Validar formato JSON compatível com Rucoy Online
