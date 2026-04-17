const ALLOWED_ORIGINS = [
	'https://tycoon-saigon.vercel.app',
	'http://localhost:3456',
	'http://localhost:3000',
];

const MAX_SYSTEM_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 4000;

export default async function handler(req, res) {
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
		const text = await response.text();
		return res.status(response.status).json({ error: text });
	}

	const data = await response.json();
	return res.status(200).json({ text: data.content[0].text });
}
