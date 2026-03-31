export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, filename } = req.body;
  if (!text || text.trim().length < 50)
    return res.status(400).json({ error: 'Text too short or empty' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a bank statement parser. Your ONLY job is to extract transactions as structured data. Do NOT categorize anything.

Extract every transaction from this bank statement. Return ONLY valid JSON — no markdown, no backticks, no explanation.

JSON structure:
{
  "bank": "bank name",
  "country": "country name",
  "accountType": "credit | debit | savings | checking",
  "currency": "3-letter code e.g. MXN BOB USD",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "exact description from statement, cleaned of account numbers and tracking codes",
      "amount": 1234.56,
      "direction": "credit | debit",
      "type": "the transaction type as written e.g. Compra, Transferencia, SPEI RECIBIDO, Tarjeta de Debito, Pago, Deposito, Retiro, Cargo, Abono",
      "reference": "the concepto, glosa, memo, or payment reference if present — the human-written note about what the payment is for. null if not present.",
      "merchantHint": "the merchant name or location if present separately from description e.g. from a Lugar or Establecimiento column. null if not present.",
      "counterpartyName": "name of the person or company on the other side of the transaction if visible. null if not present.",
      "counterpartyAccount": "account number or CLABE of the counterparty if visible. null if not present."
    }
  ]
}

Parsing rules:
1. direction "credit" = money IN to this account (abono, depósito, ingreso, haber, positive amount)
   direction "debit"  = money OUT of this account (cargo, retiro, pago, gasto, debe, negative amount)
2. Keep amounts always positive — direction handles the sign
3. For Excel/CSV files with columns: map each column to the closest field above
4. Extract the "reference" from concepto/glosa/memo fields — this is the human note about the payment purpose
5. Extract "merchantHint" from Lugar/Establecimiento/merchant columns when present
6. Keep descriptions clean but complete — remove raw account numbers and tracking hashes but keep meaningful text
7. Include ALL transactions — interest, fees, corrections, everything
8. For MSI installment plans listed separately, include each as its own transaction with type "MSI Plan"
9. Do NOT skip any rows — if uncertain, include with best guess

Statement:
${text.slice(0, 100000)}`;

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
        max_tokens: 16000,
        temperature: 0,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bank:        { type: 'string' },
                country:     { type: 'string' },
                accountType: { type: 'string', enum: ['credit','debit','savings','checking'] },
                currency:    { type: 'string' },
                periodStart: { type: 'string' },
                periodEnd:   { type: 'string' },
                transactions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      date:               { type: 'string' },
                      description:        { type: 'string' },
                      amount:             { type: 'number' },
                      direction:          { type: 'string', enum: ['credit','debit'] },
                      type:               { type: ['string','null'] },
                      reference:          { type: ['string','null'] },
                      merchantHint:       { type: ['string','null'] },
                      counterpartyName:   { type: ['string','null'] },
                      counterpartyAccount:{ type: ['string','null'] },
                    },
                    required: ['date','description','amount','direction','type','reference','merchantHint','counterpartyName','counterpartyAccount'],
                  },
                },
                msiPlans: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      description:       { type: 'string' },
                      originalAmount:    { type: 'number' },
                      pendingTotal:      { type: 'number' },
                      monthlyPayment:    { type: 'number' },
                      installmentNumber: { type: 'number' },
                      totalInstallments: { type: 'number' },
                    },
                    required: ['description','originalAmount','pendingTotal','monthlyPayment','installmentNumber','totalInstallments'],
                  },
                },
              },
              required: ['bank','country','accountType','currency','periodStart','periodEnd','transactions','msiPlans'],
            },
          },
        },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    // With structured outputs, content is guaranteed valid JSON
    const raw = data.content?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Structured output parse failed', raw: raw.slice(0, 300) });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
