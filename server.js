const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const Busboy = require('busboy');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

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
                response_format: 'verbose_json'
            });

            // If no_speech_prob is high, it's silence/noise — discard
            const noSpeechProb = transcription.segments && transcription.segments.length > 0
                ? transcription.segments[0].no_speech_prob
                : 0;
            if (noSpeechProb > 0.5) {
                return res.json({ text: '' });
            }

            const raw = (transcription.text || '').trim();

            // Filter common Whisper hallucinations
            const hallucinations = [
                '시청해주셔서', '영상 봐주셔서', '영상봐주셔서', '오늘도 영상',
                '구독과 좋아요', '구독버튼', '좋아요버튼', '다음 영상에서 만나요',
                'thank you for watching', 'thanks for watching', 'please subscribe',
                'performance data collection', 'subtitles by', 'like and subscribe'
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

app.post('/summarize', (req, res) => {
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const bb = Busboy({ headers: req.headers });
    let audioBuffer = null;
    let audioMime = 'audio/webm';
    let lang = 'ko';

    bb.on('file', (name, file, info) => {
        audioMime = info.mimeType || 'audio/webm';
        const chunks = [];
        file.on('data', chunk => chunks.push(chunk));
        file.on('close', () => { audioBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, val) => {
        if (name === 'lang') lang = val;
    });

    bb.on('close', async () => {
        try {
            if (!audioBuffer) {
                return res.status(400).json({ error: '오디오 파일이 없습니다.' });
            }

            const prompt = lang === 'ko'
                ? '이 음성 대화를 듣고 주요 내용을 3문장 이내로 요약해 주세요. 대화가 아니라면 "소음만 감지되었습니다"라고 응답해 주세요.'
                : 'Listen to this conversation and summarize the main points in under 3 sentences. If there is no speech, reply with "Only noise detected."';

            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: prompt },
                                { inline_data: { mime_type: audioMime, data: audioBuffer.toString('base64') } }
                            ]
                        }]
                    })
                }
            );

            const geminiData = await geminiRes.json();
            const summary = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            res.json({ summary });
        } catch (err) {
            console.error('Summarize error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.post('/getTopic', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });

    try {
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: `Translate or normalize this topic into one simple English word (lowercase, no spaces, no punctuation). Similar or synonymous topics must map to the same word. Examples: 사랑->love, 행복->happiness, 연애->love, 음악->music, 여행->travel. Output only the single English word, nothing else.\n\nTopic: ${topic.trim()}` }]
                    }],
                    generationConfig: { maxOutputTokens: 10, temperature: 0 }
                })
            }
        );

        const data = await geminiRes.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log('Gemini response:', JSON.stringify(data));
        let normalized = (raw || '').trim().toLowerCase();
        normalized = normalized.replace(/[^a-z0-9_]/g, '').slice(0, 64) || 'general';
        res.json({ topic: normalized, debug_raw: raw, debug_status: geminiRes.status, debug_error: data.error });
    } catch (err) {
        console.error('getTopic error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/listmodels', async (req, res) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`);
    const d = await r.json();
    res.json(d);
});

app.post('/sendVerifyEmail', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email and code required' });
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        return res.status(500).json({ error: 'Email not configured' });
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d0e12;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0e12;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#16181f;border-radius:16px;overflow:hidden;max-width:480px;">
        <tr>
          <td align="center" style="padding:36px 40px 24px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:3px;color:#ffffff;">BOUNDLESS TALK</div>
            <div style="width:40px;height:2px;background:#00e5ff;margin:10px auto 0;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 40px 28px;">
            <p style="color:rgba(255,255,255,0.55);font-size:14px;line-height:1.7;margin:0 0 28px;">
              아래 인증 코드를 입력하여 이메일 인증을 완료해 주세요.<br>
              <span style="font-size:12px;color:rgba(255,255,255,0.3);">Enter the code below to verify your email.</span>
            </p>
            <div style="background:#0d0e12;border:1.5px solid rgba(0,229,255,0.3);border-radius:12px;padding:22px 40px;display:inline-block;">
              <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#00e5ff;">${code}</div>
            </div>
            <p style="color:rgba(255,255,255,0.25);font-size:11px;margin:20px 0 0;">이 코드는 10분간 유효합니다 · Valid for 10 minutes</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 40px 32px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="color:rgba(255,255,255,0.2);font-size:11px;margin:0;">본인이 요청하지 않았다면 이 메일을 무시해 주세요.<br>If you didn't request this, please ignore this email.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
        await transporter.sendMail({
            from: `"BOUNDLESS TALK" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: `[BOUNDLESS TALK] 이메일 인증 코드: ${code}`,
            html
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('sendVerifyEmail error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`B-Talk server running on port ${PORT}`));
