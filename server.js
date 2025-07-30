require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Configurações iniciais
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Configuração Supabase (para armazenamento de arquivos)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuração Prisma
const prisma = new PrismaClient();

// Configuração Multer para upload local temporário
const upload = multer({ dest: 'uploads/' });

// Variáveis para controle de usuários online
const onlineUsers = new Map();

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'seu_segredo_super_secreto';

// Rotas de autenticação
app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Verifica se usuário já existe
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] }
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'Usuário ou email já existe' });
    }
    
    // Criptografa a senha
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Cria novo usuário
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        avatar: `https://ui-avatars.com/api/?name=${username}&background=random`
      }
    });
    
    // Gera token JWT
    const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ user: newUser, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao registrar usuário' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Busca usuário
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Verifica senha
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    
    // Gera token JWT
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ user, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Middleware de autenticação JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.sendStatus(401);
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Rota para upload de arquivos
app.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    
    // Faz upload para o Supabase Storage
    const fileExt = path.extname(req.file.originalname);
    const fileName = `${Date.now()}${fileExt}`;
    const filePath = `chat_files/${fileName}`;
    
    const { data, error } = await supabase.storage
      .from('chat-bucket')
      .upload(filePath, req.file.path, {
        contentType: req.file.mimetype,
        upsert: false
      });
    
    if (error) throw error;
    
    // Obtém URL pública do arquivo
    const { data: { publicUrl } } = supabase.storage
      .from('chat-bucket')
      .getPublicUrl(filePath);
    
    // Salva referência do arquivo no banco de dados
    const fileRecord = await prisma.file.create({
      data: {
        name: req.file.originalname,
        url: publicUrl,
        type: req.file.mimetype,
        size: req.file.size,
        userId: req.user.userId
      }
    });
    
    res.json(fileRecord);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao fazer upload do arquivo' });
  } finally {
    // Limpa arquivo temporário
    if (req.file) {
      const fs = require('fs');
      fs.unlinkSync(req.file.path);
    }
  }
});

// Rota para listar usuários online
app.get('/online-users', authenticateToken, (req, res) => {
  const users = Array.from(onlineUsers.values());
  res.json(users);
});

// Rota para histórico de mensagens
app.get('/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatar: true
          }
        },
        file: true
      }
    });
    
    res.json(messages.reverse());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// Configuração Socket.io
io.on('connection', (socket) => {
  console.log('Novo cliente conectado:', socket.id);
  
  // Evento para quando um usuário entra no chat
  socket.on('user-connected', async (userId) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          avatar: true
        }
      });
      
      if (user) {
        onlineUsers.set(socket.id, user);
        io.emit('user-online', Array.from(onlineUsers.values()));
      }
    } catch (error) {
      console.error('Erro ao buscar usuário:', error);
    }
  });
  
  // Evento para enviar mensagem
  socket.on('send-message', async ({ userId, text, fileId }) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          avatar: true
        }
      });
      
      if (!user) return;
      
      const message = await prisma.message.create({
        data: {
          text,
          userId: user.id,
          fileId: fileId || null
        },
        include: {
          file: true,
          user: {
            select: {
              id: true,
              username: true,
              avatar: true
            }
          }
        }
      });
      
      io.emit('new-message', message);
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
    }
  });
  
  // Evento para desconexão
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('user-offline', Array.from(onlineUsers.values()));
    console.log('Cliente desconectado:', socket.id);
  });
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Tratamento de erros global
process.on('unhandledRejection', (err) => {
  console.error('Erro não tratado:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Exceção não capturada:', err);
});