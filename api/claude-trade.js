const ALLOWED_ORIGINS = [
	'https://tycoon-saigon.vercel.app',
	'http://localhost:3456',
	'http://localhost:3000',
];

const MAX_SYSTEM_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 4000;

// --- In-memory IP-based rate limiter ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max requests per IP per window
const rateLimitMap = new Map(); // ip -> { count, resetTime }

// Periodically clean up expired entries (every 2 minutes)
setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of rateLimitMap) {
		if (now > entry.resetTime) {
			rateLimitMap.delete(ip);
		}
	}
}, 2 * 60 * 1000);

function isRateLimited(ip) {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);
	if (!entry || now > entry.resetTime) {
		rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}
	entry.count++;
	if (entry.count > RATE_LIMIT_MAX) {
		return true;
	}
	return false;
}

export default async function handler(req, res) {
	try {
		// --- Rate limiting ---
		const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
			|| req.socket?.remoteAddress
			|| 'unknown';
		if (isRateLimited(clientIp)) {
			return res.status(429).json({ error: 'Too many requests. Please try again later.' });
		}

		if (req.method !== 'POST') {
			res.setHeader('Allow', 'POST');
			return res.status(405).json({ error: 'Method not allowed' });
		}

		const origin = req.headers.origin || req.headers.referer || '';
		if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			return res.status(500).json({ error: 'Server API key not configured' });
		}

		const { system, userMessage } = req.body || {};
		if (!system || typeof system !== 'string' || !userMessage || typeof userMessage !== 'string') {
			return res.status(400).json({ error: 'Invalid payload' });
		}

		if (system.length > MAX_SYSTEM_LENGTH || userMessage.length > MAX_MESSAGE_LENGTH) {
			return res.status(400).json({ error: 'Payload too large' });
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: 'claude-sonnet-4-20250514',
				max_tokens: 512,
				system: system,
				messages: [{ role: 'user', content: userMessage }],
			}),
		});

		if (!response.ok) {
			return res.status(502).json({ error: 'Upstream AI service error' });
		}

		const data = await response.json();
		return res.status(200).json({ text: data.content[0].text });
	} catch (err) {
		console.error('claude-trade handler error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}
