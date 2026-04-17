export default async function handler(req, res) {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return res.status(500).json({ error: 'Server API key not configured' });
	}

	const { system, userMessage } = req.body;
	if (!system || !userMessage) {
		return res.status(400).json({ error: 'Missing system or userMessage' });
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
