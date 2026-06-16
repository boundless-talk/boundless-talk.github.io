const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const Busboy = require('busboy');

const app = express();
app.use(cors());
app.use(express.json());

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TOKEN_EXPIRY_SEC = 3600;

app.get('/token', (req, res) => {
    const { channelName, uid } = req.query;

    if (!channelName || uid === undefined) {
        return res.status(400).json({ error: 'channelName and uid are required' });
    }

    if (!APP_ID || !APP_CERTIFICATE) {
        return res.status(500).json({ error: 'Server misconfigured' });
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + TOKEN_EXPIRY_SEC;

    const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        parseInt(uid),
        RtcRole.PUBLISHER,
        privilegeExpireTime,
        privilegeExpireTime
    );

    res.json({ token });
});

app.post('/transcribe', (req, res) => {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI key not configured' });

    const bb = Busboy({ headers: req.headers });
    let audioBuffer = null;
    let audioMime = 'audio/webm';
    let lang = '';

    bb.on('file', (name, file, info) => {
        audioMime = info.mimeType || 'audio/webm';
        const chunks = [];
        file.on('data', chunk => chunks.push(chunk));
        file.on('close', () => { audioBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, val) => {
        if (name === 'lang') lang = val.split('-')[0]; // 'zh-CN' → 'zh'
    });

    bb.on('close', async () => {
        if (!audioBuffer || audioBuffer.length < 500) {
            return res.json({ text: '' });
        }
        try {
            const ext = audioMime.includes('mp4') ? 'm4a' : 'webm';
            const { FormData, Blob } = globalThis;

            const formData = new FormData();
            const blob = new Blob([audioBuffer], { type: audioMime });
            formData.append('file', blob, `audio.${ext}`);
            formData.append('model', 'whisper-1');
            if (lang) formData.append('language', lang);
            formData.append('response_format', 'text');

            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                body: formData
            });

            if (!response.ok) {
                const err = await response.text();
                console.error('Whisper API error:', err);
                return res.status(500).json({ error: 'Whisper failed' });
            }

            const text = await response.text();
            res.json({ text: text.trim() });
        } catch (e) {
            console.error('Transcribe error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    req.pipe(bb);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
