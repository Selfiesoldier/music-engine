import fs from 'fs';

const mainDir = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main';
const connMgrPath = `${mainDir}/core/connection_manager.py`;
const msgUtilsPath = `${mainDir}/core/message_utils.py`;

// 1. Patch core/connection_manager.py for Instant Reconnection on Socket Close
let connMgr = fs.readFileSync(connMgrPath, 'utf8');

const oldCheck = `                if ws is None or ws.closed:
                    raise ConnectionResetError("WebSocket connection is closed or unavailable")`;

const newCheck = `                if ws is None or ws.closed:
                    print("⚡ [ConnectionManager] Underlying WebSocket is closed - triggering instant reconnect...")
                    write_system_log("Underlying WebSocket closed - triggering instant reconnect")
                    self.restart_reason = "Underlying WebSocket transport closed"
                    self.restart_event.set()
                    return`;

if (connMgr.includes(oldCheck)) {
  connMgr = connMgr.replace(oldCheck, newCheck);
  fs.writeFileSync(connMgrPath, connMgr, 'utf8');
  console.log('✅ connection_manager.py patched with instant reconnect on socket close');
} else {
  console.warn('⚠️ Could not find exact oldCheck in connection_manager.py');
}

// 2. Patch core/message_utils.py to cleanly swallow closing transport errors
let msgUtils = fs.readFileSync(msgUtilsPath, 'utf8');

const oldChat = `        for i, chunk in enumerate(chunks):
            await highrise_client.chat(chunk)
            # Add delay between chunks (except after the last one)
            if i < len(chunks) - 1:
                await asyncio.sleep(MessageChunker.DELAY_BETWEEN_CHUNKS)`;

const newChat = `        for i, chunk in enumerate(chunks):
            try:
                await highrise_client.chat(chunk)
            except (ConnectionResetError, OSError, Exception) as chat_err:
                err_str = str(chat_err).lower()
                if "closing transport" in err_str or "connection" in err_str or "closed" in err_str:
                    print(f"⚠️ [Chat] Transport closed while sending message, skipped cleanly ({chat_err})")
                    return i
                raise
            # Add delay between chunks (except after the last one)
            if i < len(chunks) - 1:
                await asyncio.sleep(MessageChunker.DELAY_BETWEEN_CHUNKS)`;

const oldWhisper = `        for i, chunk in enumerate(chunks):
            await highrise_client.send_whisper(user_id, chunk)
            # Add delay between chunks (except after the last one)
            if i < len(chunks) - 1:
                await asyncio.sleep(MessageChunker.DELAY_BETWEEN_CHUNKS)`;

const newWhisper = `        for i, chunk in enumerate(chunks):
            try:
                await highrise_client.send_whisper(user_id, chunk)
            except (ConnectionResetError, OSError, Exception) as whisper_err:
                err_str = str(whisper_err).lower()
                if "closing transport" in err_str or "connection" in err_str or "closed" in err_str:
                    print(f"⚠️ [Whisper] Transport closed while sending whisper, skipped cleanly ({whisper_err})")
                    return i
                raise
            # Add delay between chunks (except after the last one)
            if i < len(chunks) - 1:
                await asyncio.sleep(MessageChunker.DELAY_BETWEEN_CHUNKS)`;

if (msgUtils.includes(oldChat)) {
  msgUtils = msgUtils.replace(oldChat, newChat);
  console.log('✅ Patched send_chunked_chat with graceful closing transport handling');
}

if (msgUtils.includes(oldWhisper)) {
  msgUtils = msgUtils.replace(oldWhisper, newWhisper);
  console.log('✅ Patched send_chunked_whisper with graceful closing transport handling');
}

fs.writeFileSync(msgUtilsPath, msgUtils, 'utf8');
console.log('✅ message_utils.py patch complete!');
