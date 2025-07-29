const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@supabase/supabase-js');

// Supabase config
const supabase = createClient(
  'https://rokjbwcnswnlosgrukqb.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2pid2Nuc3dubG9zZ3J1a3FiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM4MjA2NTcsImV4cCI6MjA2OTM5NjY1N30.bTakra3Shi5MbXH7HVhjU6ExmC7BB6kvU-qYORJGhfc'
);

const prisma = new PrismaClient();
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

// 🧠 Cria tabela se não existir
async function inicializar() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Message" (
      "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "imageUrl" TEXT,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Tabela Message pronta');
}

// 📨 Enviar mensagem com imagem
app.post('/message', upload.single('image'), async (req, res) => {
  const { userId, content } = req.body;
  let imageUrl = null;

  try {
    if (req.file) {
      const buffer = fs.readFileSync(req.file.path);
      const ext = path.extname(req.file.originalname);
      const fileName = `img-${Date.now()}${ext}`;

      const { data, error } = await supabase.storage
        .from('chat-images')
        .upload(fileName, buffer, { contentType: req.file.mimetype });

      if (error) throw error;

      imageUrl = `https://rokjbwcnswnlosgrukqb.supabase.co/storage/v1/object/public/chat-images/${fileName}`;
      fs.unlinkSync(req.file.path);
    }

    const msg = await prisma.message.create({ data: { userId, content, imageUrl } });
    res.json(msg);
  } catch (err) {
    console.error('❌ Erro:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// 📄 Buscar mensagens
app.get('/messages', async (req, res) => {
  try {
    const messages = await prisma.message.findMany({ orderBy: { createdAt: 'asc' } });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

app.listen(3000, async () => {
  await inicializar();
  console.log('🚀 Server pronto em http://localhost:3000');
});