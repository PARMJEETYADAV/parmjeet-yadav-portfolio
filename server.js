import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use(express.json());

// Identify if running live on Vercel
const isVercel = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const dataDir = isVercel ? path.join(os.tmpdir(), 'data') : path.join(__dirname, 'data');

const profilePath = path.join(__dirname, 'data', 'portfolio.json');
const cachePath = isVercel ? path.join(dataDir, 'cache.json') : path.join(__dirname, 'data', 'cache.json');

let state = {
    profile: {},
    skills: [],
    projects: [],
    certifications: [],
    experience: [],
    education: [],
    githubRepos: [],
    githubActivity: [],
    githubStats: {},
    syncedAt: null,
    lastError: null,
};

let syncInFlight = false;

async function readJson(filePath, fallback = {}) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        // Fallback to embedded repo files if /tmp directory is empty on boot
        try {
            const baseName = path.basename(filePath);
            const localFallback = path.join(__dirname, 'data', baseName);
            const raw = await fs.readFile(localFallback, 'utf8');
            return JSON.parse(raw);
        } catch {
            return fallback;
        }
    }
}

function toTitleCase(text) {
    return text
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

// LinkedIn normalization functions removed - no longer processing LinkedIn data

async function loadBaseData() {
    const base = await readJson(profilePath, { profile: {}, projects: [], skills: [], certifications: [], experience: [], education: [] });
    const cache = await readJson(cachePath, {});

    state.profile = base.profile || {};
    state.skills = base.skills || [];
    state.projects = base.projects || [];
    state.certifications = base.certifications || [];
    state.experience = base.experience || [];
    state.education = base.education || [];
    state.githubRepos = base.githubRepos || [];
    state.githubActivity = cache.githubActivity || [];
    state.githubStats = cache.githubStats || {};
    state.syncedAt = cache.syncedAt || null;
    state.lastError = cache.lastError || null;
}

async function syncGitHub() {
    const username = process.env.GITHUB_USERNAME || 'parmjeet-yadav';
    const token = process.env.GITHUB_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    try {
        const userRes = await fetch(`https://api.github.com/users/${username}`, { headers });
        if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
        const user = await userRes.json();

        const reposRes = await fetch(`https://api.github.com/users/${username}/repos?per_page=6&sort=updated`, { headers });
        if (!reposRes.ok) throw new Error(`GitHub repos lookup failed: ${reposRes.status}`);
        const repos = await reposRes.json();

        state.githubRepos = repos.map((repo) => ({
            name: repo.name,
            description: repo.description || 'Repository updated recently.',
            homepage: repo.homepage || null,
            html_url: repo.html_url,
            language: repo.language || 'Mixed',
            stargazers_count: repo.stargazers_count || 0,
            forks_count: repo.forks_count || 0,
            updated_at: repo.updated_at,
        }));

        state.githubStats = {
            login: user.login,
            public_repos: user.public_repos || 0,
            followers: user.followers || 0,
            public_gists: user.public_gists || 0,
            html_url: user.html_url,
            avatar_url: user.avatar_url,
            last_updated: new Date().toISOString(),
        };
    } catch (error) {
        state.lastError = error.message;
    }
}

// LinkedIn sync function removed - no longer fetching LinkedIn data

async function syncSources() {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
        await loadBaseData();
        await syncGitHub();
        state.syncedAt = new Date().toISOString();
        
        // FIXED: Wrap write system operations inside a rigorous try/catch to ensure zero top-level runtime crashes
        try {
            await fs.mkdir(dataDir, { recursive: true });
            await fs.writeFile(cachePath, JSON.stringify({
                syncedAt: state.syncedAt,
                githubActivity: state.githubActivity,
                githubStats: state.githubStats,
                lastError: state.lastError,
            }, null, 2));
        } catch (writeError) {
            console.warn("Write operation skipped on Serverless Container environment:", writeError.message);
        }
    } finally {
        syncInFlight = false;
    }
}

app.get('/', async (req, res) => {
    // Prevent dynamic file writes from stalling the initial render payload
    if (!state.syncedAt) {
        await loadBaseData();
    }
    res.render('index', { state, titleCase: toTitleCase });
});

app.get('/api/refresh', async (req, res) => {
    await syncSources();
    res.json({ ok: true, syncedAt: state.syncedAt, repositories: state.githubRepos.length });
});

// LinkedIn API endpoints removed - no longer fetching LinkedIn data

app.post('/api/webhooks/github', (req, res) => {
    const payload = req.body || {};
    const entry = {
        type: 'github',
        event: req.get('X-GitHub-Event') || 'ping',
        actor: payload.sender?.login || 'unknown',
        repo: payload.repository?.full_name || 'unknown',
        at: new Date().toISOString(),
    };
    state.githubActivity = [entry, ...state.githubActivity].slice(0, 6);
    res.json({ ok: true, received: entry });
});

// FIXED: Bootstrap data engine gracefully during server initialization
// Dropped raw top-level unhandled execution paths completely
try {
    await loadBaseData();
} catch (err) {
    console.error("Initial basic startup data bootstrap failed:", err.message);
}

if (!isVercel) {
    app.listen(port, () => {
        console.log(`Portfolio SSR server running at http://localhost:${port}`);
    });

    setInterval(() => {
        syncSources().catch((error) => {
            state.lastError = error.message;
        });
    }, 1000 * 60 * 2);
}

app.use((req, res) => {
    res.status(404).send('Page not found');
});

export default app;
