# 🔐 API Keys & Infrastructure Vault

This document contains a centralized, properly labeled record of all API keys, panel tokens, and service credentials across your Highrise bot fleet and music streaming infrastructure.

---

## 1. 🖥️ Ori Host Pterodactyl Client API Keys

### Key 1 — Fleet Cluster (Master CEO & Workers)
- **API Key**: `ptlc_xH3DUb27dLGERsgqHo1qsearZNuPUu65nFvUMWAY1RQ`
- **Panel URL**: `https://panel.orihost.com`
- **Managed Servers**:
  1. **Master Cashier Bot (CEO)**
     - **Server ID**: `15522d70`
     - **Node**: DE-07
     - **Address**: `176.100.37.77:30077`
  2. **Ori Host Worker 1**
     - **Server ID**: `fdb54977`
     - **Node**: DE-08
     - **Address**: `92.118.206.4:30018`
  3. **Ori Host Worker 2**
     - **Server ID**: `7794efa4`
     - **Node**: DE-02
     - **Address**: `194.62.248.55:30019`

---

### Key 2 — Music Servers Group A (Servers 5, 6, 7)
- **API Key**: `ptlc_mw4jh0z0fwiAWOMfFnovcKkX97MSfvI5zsevDTY7qtl`
- **Panel URL**: `https://panel.orihost.com`
- **Managed Servers**:
  1. **music server 5**
     - **Server ID**: `763749f7`
     - **Node**: DE-02
     - **Address**: `194.62.248.55:30266`
  2. **music server 6**
     - **Server ID**: `b01f02f6`
     - **Node**: DE-07
     - **Address**: `176.100.37.77:30099`
  3. **musicserver 7**
     - **Server ID**: `32cff698`
     - **Node**: DE-05
     - **Address**: `2.56.246.119:30093`

---

### Key 3 — Music Servers Group B (Servers 1, 2, 8)
- **API Key**: `ptlc_WqGGhTvnzl5Teb9dU0WfiSGQnCxuqbOZNKwkJNzCs4L`
- **Panel URL**: `https://panel.orihost.com`
- **Managed Servers**:
  1. **music server 1**
     - **Server ID**: `1b7e7c20`
     - **Node**: DE-05
     - **Address**: `2.56.246.119:30029`
  2. **music server 2**
     - **Server ID**: `6e0467de`
     - **Node**: DE-02
     - **Address**: `194.62.248.55:30241`
  3. **musicserver 8**
     - **Server ID**: `c4adc7c1`
     - **Node**: DE-02
     - **Address**: `194.62.248.55:30246`

---

### Key 4 — Music Servers Group C (Servers 3, 4)
- **API Key**: `ptlc_zQ3jtfbFj0VtarmV1WQ9VZrV6xEN271uDYl2bwTSmyp`
- **Panel URL**: `https://panel.orihost.com`
- **Managed Servers**:
  1. **music server 3**
     - **Server ID**: `9bb1b040`
     - **Node**: DE-08
     - **Address**: `92.118.206.4:30178`
  2. **music server 4**
     - **Server ID**: `a38f28c5`
     - **Node**: DE-07
     - **Address**: `176.100.37.77:30094`

---

## 2. ⚡ Audio Streaming & Download Infrastructure

- **Active Dedicated Audio Server**:
  - **Server ID**: `00f50ae1`
  - **Node**: DE-04 (`92.118.206.166:30238`)
  - **Stream URL**: `http://92.118.206.166:30238/stream`
  - **Health URL**: `http://92.118.206.166:30238/health`
  - **Status URL**: `http://92.118.206.166:30238/status`
  - **Panel Key**: `ptlc_xH3DUb27dLGERsgqHo1qsearZNuPUu65nFvUMWAY1RQ`
  - **Audio Secret**: `supersecret_audio_key_123`
  - **Format**: 96 kbps CBR MP3 (`audio/mpeg`), 64 KB burst-on-connect buffer
  - **Resource Usage**: ~3% CPU, 43 MB RAM (Zero-CPU direct streaming)

- **Main Controller (Queue & Bridge Coordinator)**:
  - **Server ID**: `6a95145f`
  - **Node**: DE-05 (`2.56.246.119:30195`)
  - **Panel Key**: `ptlc_UDJ3zLc9mdsYEeMnEKbApVX3daRQYvfyWn0xc7Efqv9`

- **Highrise Bot Worker**:
  - **Server ID**: `bf9ef46f`
  - **Stream Input (PUBLIC_URL)**: `http://92.118.206.166:30238`
  - **Panel Key**: `ptlc_KuhhwXoG0UQlomK8eym7hegwjP4fdfeKpl2JuyYC5yp`

- **Decommissioned / Stopped Audio Servers**:
  - `c9520139` (Node DE-05) — Stopped & Powered Off
  - `4c1b3907` (Node DE-05) — Stopped & Powered Off

- **Dedicated Download Worker URL**:
  `http://176.100.37.77:30033`
  *(Offloads YouTube / audio extraction from music streaming servers)*
- **Music API Secret**:
  `highrise_music_secret_2026`
- **Fleet WebSocket Control Secret**:
  `highrise_fleet_master_secret_2026`

---

## 3. 🎙️ AI, Speech & Voice Services

- **ElevenLabs API Key**:
  `sk_22283c8c66f4fa78111840056471b2baf62355afd47922e1`
- **ElevenLabs Default Voice ID**:
  `pNInz6obpgDQGcFmaJgB`
- **FreeLLM API Key**:
  `freellmapi-a232512ffbce32934b0d8e523b0e3a9d03ccfa03048b4624`
- **FreeLLM Base URL**:
  `https://freellmapi-latest-1-wr27.onrender.com/v1`

---

## 4. 🤖 Highrise Credentials

- **Highrise Bot API Token**:
  `4c04a382f5756837ee99d0c5f12f0cfc140ec9153b2462ed7c548cc760c54794`
- **Admin Highrise User ID**:
  `6a7adddacc3fa67f5530833c` (@_paul_sanif_)
- **Default Room ID**:
  `6a9865186e9936ccdd6bd143`
