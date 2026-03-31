export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transactions, currency, country } = req.body;
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'transactions array required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // Format each transaction with ALL available context
  const formatted = transactions.map((t, i) => {
    const parts = [`${i + 1}. description: "${t.description}"`];
    if (t.type)             parts.push(`type: "${t.type}"`);
    if (t.reference)        parts.push(`reference: "${t.reference}"`);
    if (t.merchantHint)     parts.push(`merchant: "${t.merchantHint}"`);
    if (t.counterpartyName) parts.push(`counterparty: "${t.counterpartyName}"`);
    parts.push(`amount: ${t.amount}`);
    parts.push(`direction: ${t.direction}`);
    return parts.join(', ');
  }).join('\n');

  const prompt = `You are a personal finance transaction categorizer. You receive full transaction context and return a category and confidence score.

Context: transactions from ${country || 'Latin America'}, currency ${currency || 'local'}.

Available categories:
EXPENSES: food, cafe, groceries, transport, health, subscriptions, shopping, education, rent, entertainment, fitness, travel, other
INCOME: salary, freelance, reimbursement, other_income
SPECIAL: internal_transfer (between own accounts), unassigned (genuinely unclear)

Category definitions:
- food: restaurants, food delivery, fast food, any eating establishment
- cafe: coffee shops, cafeterias, bakeries
- groceries: supermarkets, convenience stores, markets, almacenes, tiendas de abarrotes
- transport: ride-hailing (Uber/DiDi), taxis, fuel, tolls, parking, public transit
- health: pharmacies, doctors, hospitals, labs, vaccines, medical services
- subscriptions: streaming (Netflix/Spotify), phone plans, SaaS, recurring digital services
- shopping: retail stores, e-commerce, clothing, electronics, general merchandise
- education: schools, universities, tuition (colegiatura), courses, tutoring
- rent: rent/arriendo/alquiler, utilities (luz/agua/internet/gas), HOA
- entertainment: movies, concerts, events, bars, clubs
- fitness: gyms, sports clubs, fitness classes
- travel: airlines, hotels, Airbnb, travel agencies
- other: legitimate expenses that don't fit above categories
- salary: payroll, commission income, regular employment income
- freelance: international payments (Wise/Stripe/PayPal), project payments, irregular professional income
- reimbursement: money received back from individuals, shared expense splits
- other_income: interest earned, refunds, government payments, misc income
- internal_transfer: money moving between own bank accounts, credit card payments
- unassigned: genuinely cannot determine with available context

Categorization strategy:
1. Use ALL fields together — type + description + reference + merchant + amount + direction
2. Transaction TYPE is very informative:
   - "Tarjeta de Debito" / "Compra" = debit card purchase → categorize by what was bought
   - "Transferencia Interbancaria" to a person = likely internal_transfer or reimbursement
   - "Transferencia" with a purpose reference = use the reference to categorize
   - "SPEI RECIBIDO" from a business = income or reimbursement
   - "Automatico" / "Interesganado" = other_income or fee
3. Reference/concepto beats description when they conflict
4. merchantHint is gold — use it aggressively
5. Confidence guide:
   - 0.9+: clear merchant name, known service, or explicit reference
   - 0.7-0.9: strong contextual clues but not 100% certain
   - 0.5-0.7: reasonable inference but could be wrong
   - below 0.5: use unassigned

Transactions:
${formatted}

Return ONLY a JSON array, one object per transaction, in the same order:
[
  {
    "index": 1,
    "category": "groceries",
    "confidence": 0.95,
    "reasoning": "Compra + Almacen = debit card purchase at a store"
  }
]

Be concise in reasoning (max 10 words).`;

  // Valid category values for the schema
  const VALID_CATEGORIES = [
    'food','cafe','groceries','transport','health','subscriptions',
    'shopping','education','rent','entertainment','fitness','travel','other',
    'salary','freelance','reimbursement','other_income',
    'internal_transfer','unassigned'
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        temperature: 0,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index:     { type: 'number' },
                  category:  { type: 'string', enum: VALID_CATEGORIES },
                  confidence:{ type: 'number', minimum: 0, maximum: 1 },
                  reasoning: { type: 'string' },
                },
                required: ['index','category','confidence','reasoning'],
              },
            },
          },
        },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    // Structured output guarantees valid JSON array
    const raw = data.content?.[0]?.text || '[]';
    let results;
    try {
      results = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Structured output parse failed', raw: raw.slice(0, 300) });
    }

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
