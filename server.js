// server.js - Backend Completo para Chat em Tempo Real (com chaves diretas e CORS)

// --- Seção 1: Configurações e Importações ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors'); // Importa a biblioteca CORS

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Permite todas as origens para Socket.io
        methods: ["GET", "POST"]
    }
});

// **ATENÇÃO: CHAVES DIRETAMENTE NO CÓDIGO. NÃO RECOMENDADO PARA PRODUÇÃO!**
const PORT = 3000;
const JWT_SECRET = "sua_chave_secreta_jwt_bem_longa_e_complexa"; // Use uma chave segura e longa!
const SUPABASE_URL = "https://rokjbwcnswnlosgrukqb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2pid2Nuc3dubG9zZ3J1a3FiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM4MjA2NTcsImV4cCI6MjA2OTM5NjY1N30.bTakra3Shi5MbXH7HVhjU6ExmC7BB6kvU-qYORJGhfc";
const SUPABASE_BUCKET_NAME = "dina"; // Nome do seu bucket no Supabase Storage

// Chave do banco de dados fornecida:
const DATABASE_URL = "postgresql://postgres.rokjbwcnswnlosgrukqb:FARIA2580222@aws-0-eu-north-1.pooler.supabase.com:5432/postgres";


// --- Seção 2: Conexão com PostgreSQL (Supabase) ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necessário para Supabase em alguns ambientes de desenvolvimento
    }
});

pool.on('error', (err) => {
    console.error('Erro inesperado no cliente PG', err);
    process.exit(-1);
});

// Teste de conexão com o banco de dados
(async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('Conexão com PostgreSQL (Supabase) estabelecida com sucesso!');
    } catch (err) {
        console.error('Erro ao conectar ao PostgreSQL (Supabase):', err.message);
        process.exit(1);
    }
})();

// --- Seção 3: Supabase Storage Client ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: false // Não persistir sessão no lado do servidor
    }
});

// --- Seção 4: Middlewares ---
// Aumenta o limite do corpo da requisição JSON para permitir uploads de arquivos maiores (via Base64)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true })); // Para dados de formulário URL-encoded, também com limite maior
app.use(cors()); // Adiciona a middleware CORS para todas as requisições HTTP

/**
 * Middleware de autenticação JWT
 * Verifica a presença e validade do token JWT no cabeçalho 'Authorization'.
 * Adiciona o `userId` à requisição (req.userId) se o token for válido.
 */
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader) {
        const token = authHeader.split(' ')[1]; // Espera "Bearer TOKEN"

        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                console.error("Erro de verificação JWT:", err.message);
                return res.sendStatus(403); // Token inválido ou expirado
            }
            req.userId = user.id; // Adiciona o ID do usuário à requisição
            next();
        });
    } else {
        res.sendStatus(401); // Nenhuma autorização fornecida
    }
};

// --- Seção 5: Gerenciamento de Usuários Online ---
const onlineUsers = new Map(); // Map<socketId, userId>
const userIdToSocketId = new Map(); // Map<userId, socketId> para fácil lookup
const userDetails = new Map(); // Map<userId, { username }> para detalhes do usuário

// Função para emitir a lista de usuários online para todos os clientes
const emitOnlineUsers = () => {
    const users = Array.from(userDetails.values()).filter(user => userIdToSocketId.has(user.id));
    io.emit('onlineUsers', users);
};

// --- Seção 6: Rotas REST para Autenticação e Upload ---

// Rota de Registro de Usuário
app.post('/auth/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // Hash da senha

        // Insere o novo usuário no banco de dados
        const result = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, hashedPassword]
        );

        const newUser = result.rows[0];
        res.status(201).json({ message: 'Usuário registrado com sucesso!', user: { id: newUser.id, username: newUser.username } });

    } catch (error) {
        if (error.code === '23505') { // Código de erro para violação de unique constraint (username já existe)
            return res.status(409).json({ message: 'Nome de usuário já existe.' });
        }
        console.error('Erro no registro:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor ao registrar usuário.' });
    }
});

// Rota de Login de Usuário
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' });
    }

    try {
        // Busca o usuário no banco de dados
        const result = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Compara a senha fornecida com o hash armazenado
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Gera um token JWT
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({ message: 'Login realizado com sucesso!', token, user: { id: user.id, username: user.username } });

    } catch (error) {
        console.error('Erro no login:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor ao fazer login.' });
    }
});

// Rota para Upload de Arquivos
app.post('/upload', authenticateJWT, async (req, res) => {
    const { filename, filedata, mimetype } = req.body; // filedata deve ser base64

    if (!filename || !filedata || !mimetype) {
        return res.status(400).json({ message: 'Filename, filedata e mimetype são obrigatórios.' });
    }

    try {
        const filePath = `${Date.now()}-${filename}`;
        const fileBuffer = Buffer.from(filedata, 'base64');

        const { data, error } = await supabase.storage
            .from(SUPABASE_BUCKET_NAME)
            .upload(filePath, fileBuffer, {
                contentType: mimetype,
                upsert: false // Não sobrescrever se já existir
            });

        if (error) {
            console.error('Erro ao fazer upload para Supabase Storage:', error);
            return res.status(500).json({ message: 'Erro ao fazer upload do arquivo.', error: error.message });
        }

        // Gera um link público de download (o Supabase geralmente cuida disso)
        // Nota: A URL retornada pelo 'data.path' é relativa. Precisamos da URL pública completa.
        const publicUrl = supabase.storage
            .from(SUPABASE_BUCKET_NAME)
            .getPublicUrl(data.path).data.publicUrl;

        res.status(200).json({ message: 'Upload realizado com sucesso!', url: publicUrl });

    } catch (error) {
        console.error('Erro no upload:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor ao fazer upload.' });
    }
});

// Rota para Histórico de Mensagens
app.get('/messages/history', authenticateJWT, async (req, res) => {
    const { limit = 50, offset = 0 } = req.query; // Paginação

    try {
        const result = await pool.query(
            `SELECT
                m.id,
                m.content,
                m.timestamp,
                m.file_url,
                u.id AS sender_id,
                u.username AS sender_username
            FROM
                messages m
            JOIN
                users u ON m.sender_id = u.id
            ORDER BY
                m.timestamp DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.status(200).json(result.rows.reverse()); // Inverte para ter as mensagens mais antigas primeiro
    } catch (error) {
        console.error('Erro ao buscar histórico de mensagens:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor ao buscar histórico de mensagens.' });
    }
});

// --- Seção 7: Eventos Socket.io ---

io.on('connection', async (socket) => {
    console.log(`Usuário conectado: ${socket.id}`);

    // Autenticação de usuário via Socket.io (opcional, mas recomendado para mensagens)
    socket.on('authenticate', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const userId = decoded.id;
            const username = decoded.username;

            // Busca os detalhes do usuário no DB para garantir que ele existe e está atualizado
            const userResult = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
            const user = userResult.rows[0];

            if (user) {
                // Remove conexões antigas do mesmo usuário
                if (userIdToSocketId.has(userId)) {
                    const oldSocketId = userIdToSocketId.get(userId);
                    onlineUsers.delete(oldSocketId);
                    // Opcional: desconectar o socket antigo se desejar que apenas uma conexão seja ativa por usuário
                    // io.sockets.sockets.get(oldSocketId)?.disconnect();
                }

                onlineUsers.set(socket.id, userId);
                userIdToSocketId.set(userId, socket.id);
                userDetails.set(userId, { id: userId, username: username }); // Armazena detalhes do usuário

                socket.userId = userId; // Adiciona userId ao objeto socket
                socket.username = username; // Adiciona username ao objeto socket
                console.log(`Usuário autenticado: ${username} (ID: ${userId}) com socket ID: ${socket.id}`);
                emitOnlineUsers(); // Notifica todos sobre a atualização dos usuários online
                socket.emit('authenticated', { status: 'success', message: 'Autenticado com sucesso!' });
            } else {
                console.log(`Usuário com ID ${userId} não encontrado.`);
                socket.emit('authenticated', { status: 'error', message: 'Usuário não encontrado.' });
                socket.disconnect(); // Desconecta se o usuário não for válido
            }
        } catch (error) {
            console.error('Falha na autenticação via Socket.io:', error.message);
            socket.emit('authenticated', { status: 'error', message: 'Falha na autenticação.' });
            socket.disconnect(); // Desconecta em caso de erro de autenticação
        }
    });

    // Envio de Mensagens
    socket.on('sendMessage', async ({ content, fileUrl = null }) => {
        // Verifica se o usuário está autenticado no socket
        if (!socket.userId) {
            console.log(`Mensagem recebida de socket não autenticado: ${socket.id}`);
            socket.emit('messageError', 'Você precisa estar autenticado para enviar mensagens.');
            return;
        }

        const senderId = socket.userId;
        const senderUsername = socket.username;

        try {
            // Insere a mensagem no banco de dados
            const result = await pool.query(
                'INSERT INTO messages (sender_id, content, file_url) VALUES ($1, $2, $3) RETURNING id, timestamp',
                [senderId, content, fileUrl]
            );
            const messageId = result.rows[0].id;
            const timestamp = result.rows[0].timestamp;

            // Prepara o objeto da mensagem para ser emitido
            const message = {
                id: messageId,
                sender_id: senderId,
                sender_username: senderUsername,
                content: content,
                file_url: fileUrl,
                timestamp: timestamp
            };

            // Emite a mensagem para todos os clientes conectados
            io.emit('receiveMessage', message);
            console.log(`Mensagem enviada por ${senderUsername}: ${content}`);
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error.message);
            socket.emit('messageError', 'Não foi possível enviar a mensagem. Tente novamente.');
        }
    });

    // Gerenciamento de Desconexão
    socket.on('disconnect', () => {
        const userId = onlineUsers.get(socket.id);
        if (userId) {
            onlineUsers.delete(socket.id);
            // Verifica se o usuário tem outras conexões ativas
            const hasOtherConnections = Array.from(onlineUsers.values()).some(id => id === userId);
            if (!hasOtherConnections) {
                userIdToSocketId.delete(userId);
                userDetails.delete(userId); // Remove os detalhes se não houver mais conexões
            }
            emitOnlineUsers(); // Notifica a atualização da lista
            console.log(`Usuário desconectado: ${socket.id} (ID: ${userId || 'N/A'})`);
        } else {
            console.log(`Socket desconectado sem autenticação prévia: ${socket.id}`);
        }
    });
});

// --- Seção 8: Inicialização do Servidor ---
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});

// --- Seção 9: Tratamento de Erros Geral ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Adicione aqui um tratamento de erro mais robusto para produção
    // Ex: Logar o erro, notificar admins, ou encerrar o processo se for crítico
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Adicione aqui um tratamento de erro mais robusto para produção
    // Em produção, você pode querer reiniciar o processo
    process.exit(1);
});