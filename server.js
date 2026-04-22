const express = require('express');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('tireconnect-backend is running');
});

app.post('/create-cart', async (req, res) => {
  try {
    const { part, qty, price, title, size } = req.body;

    if (!part) {
      return res.status(400).json({ error: 'Missing part' });
    }

    return res.json({
      ok: true,
      message: 'Backend received tire data successfully',
      data: {
        part,
        qty: qty || 1,
        price: price || null,
        title: title || null,
        size: size || null
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
