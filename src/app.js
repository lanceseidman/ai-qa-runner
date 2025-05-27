import express from 'express';
import cors from 'cors';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { runQATest } from './ai.js';
import { v4 as uuidv4 } from 'uuid';

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Initialize Express app
const app = express();

// Store results by ID
const resultsStore = new Map();

// Log requests for debugging
app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    next();
});

// Middleware
app.use(cors({
    origin: "http://localhost:3003",
    methods: ["GET", "POST"],
}));
app.use(express.json());

// Serve static files
const publicPath = join(__dirname, 'public');
console.log(`Serving static files from: ${publicPath}`);
app.use(express.static(publicPath, {
    index: false
}));

// Explicit routes for / and /index.html
app.get(['/', '/index.html'], (req, res) => {
    const filePath = join(publicPath, 'index.html');
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error(`Error serving ${filePath}:`, err);
            res.status(404).send('Cannot GET /index.html');
        }
    });
});

// API endpoint to start analysis
app.post('/api/analyze-workflow', async (req, res) => {
    const { url, instructions, options } = req.body;
    const analysisId = uuidv4();

    try {
        console.log('Received analyze-workflow request:', { analysisId, url, instructions, options });
        resultsStore.set(analysisId, { status: 'running', message: 'Analysis started' });

        // Run analysis in background
        runQATest(url, instructions, options)
            .then(result => {
                console.log('Analyze-workflow result:', { analysisId, result });
                resultsStore.set(analysisId, result);
            })
            .catch(error => {
                console.error('Analyze-workflow error:', {
                    analysisId,
                    message: error.message,
                    name: error.name,
                    stack: error.stack,
                    error: error
                });
                resultsStore.set(analysisId, {
                    status: 'error',
                    message: error.message || 'Internal server error',
                    error: error.message,
                    stack: error.stack
                });
            });

        res.json({ analysisId, status: 'running', message: 'Analysis started' });
    } catch (error) {
        console.error('Analyze-workflow immediate error:', {
            analysisId,
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error
        });
        resultsStore.set(analysisId, {
            status: 'error',
            message: error.message || 'Internal server error',
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({
            analysisId,
            error: 'QA test failed',
            message: error.message || 'Internal server error',
            stack: error.stack
        });
    }
});

// API endpoint to get results by ID
app.get('/api/results/:id', (req, res) => {
    const analysisId = req.params.id;
    const result = resultsStore.get(analysisId);

    if (!result) {
        return res.status(404).json({ error: 'Results not found for ID', analysisId });
    }

    res.json(result);
});

// Start server
const PORT = process.env.PORT || 3003;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});