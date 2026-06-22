 #!/bin/bash
 cd "$(dirname "$0")"
 
 echo "🚀 启动德州扑克筹码模拟器 + 公网隧道"
 echo ""
 
 # 1. Start the poker server
 node server.js &
 SERVER_PID=$!
 echo "📡 扑克服务已启动 (PID: $SERVER_PID)"
 sleep 2
 
 # 2. Start ngrok tunnel
 echo "⏳ 正在创建公网隧道..."
 npx ngrok http 3000 --log=stdout > /tmp/ngrok.log 2>&1 &
 NGROK_PID=$!
 sleep 3
 
 # 3. Get the public URL
 NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
 
 if [ -n "$NGROK_URL" ]; then
   echo ""
   echo "======================================"
   echo "✅ 公网地址: $NGROK_URL"
   echo "======================================"
   echo ""
   echo "发送这个地址给朋友们，他们在浏览器打开就能加入游戏！"
   echo ""
   echo "按 Ctrl+C 停止所有服务"
 else
   echo "⚠️  未能获取公网地址，试试: http://127.0.0.1:3000 (仅本机)"
   echo "  等几秒后访问 http://127.0.0.1:4040 查看 ngrok 状态"
 fi
 
 # Wait for interrupt
 wait $SERVER_PID
