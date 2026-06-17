const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const Busboy = require('busboy');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
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
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    }

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
        if (name === 'lang') lang = val.split('-')[0];
    });

    bb.on('close', async () => {
        try {
            if (!audioBuffer || audioBuffer.length < 8000) {
                return res.json({ text: '' });
            }

            const ext = audioMime.includes('mp4') ? 'm4a' : 'webm';
            const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const transcription = await client.audio.transcriptions.create({
                file: await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: audioMime }),
                model: 'whisper-1',
                language: lang || undefined,
                response_format: 'text'
            });

            const raw = typeof transcription === 'string' ? transcription.trim() : (transcription.text || '').trim();

            // Filter common Whisper hallucinations on silence
            const hallucinations = [
                '시청해주셔서 감사합니다', '구독', '좋아요', 'thank you for watching',
                'thanks for watching', 'please subscribe', 'performance data collection',
                'MBC', 'KBS', 'subtitles by'
            ];
            const isHallucination = hallucinations.some(h => raw.toLowerCase().includes(h.toLowerCase()));
            const text = isHallucination ? '' : raw;

            res.json({ text });
        } catch (err) {
            console.error('Transcription error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`B-Talk server running on port ${PORT}`));
