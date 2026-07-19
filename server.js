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
const linkedinPath = isVercel ? path.join(dataDir, 'linkedin.json') : path.join(__dirname, 'data', 'linkedin.json');
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
    linkedinHighlights: [],
    linkedinActivity: [],
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

function normalizeLinkedInExperience(items = []) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
        if (typeof item === 'string') {
            return {
                role: item,
                organization: 'LinkedIn',
                period: 'Now',
                summary: 'Imported from LinkedIn.',
                source: 'linkedin',
            };
        }
        return {
            role: item.role || item.title || item.position || item.jobTitle || item.designation || 'Professional Update',
            organization: item.organization || item.company || item.employer || 'LinkedIn',
            period: item.period || item.duration || item.date || 'Now',
            summary: item.summary || item.description || item.responsibilities || 'Imported from LinkedIn.',
            source: 'linkedin',
        };
    });
}

function normalizeLinkedInSkills(items = []) {
    if (!Array.isArray(items)) return [];
    return items.map((skill) => ({
        category: skill.category || 'LinkedIn Skills',
        items: Array.isArray(skill.items) ? skill.items : [skill.name || skill].filter(Boolean),
        source: 'linkedin',
    }));
}

async function loadLinkedInData() {
    return readJson(linkedinPath, { profile: {}, highlights: [], activity: [], experience: [], education: [], skills: [] });
}

async function loadBaseData() {
    const base = await readJson(profilePath, { profile: {}, projects: [], skills: [], certifications: [], experience: [], education: [] });
    const linkedin = await loadLinkedInData();
    const cache = await readJson(cachePath, {});

    state.profile = { ...base.profile, ...linkedin.profile };
    state.skills = [
        ...(base.skills || []),
        ...normalizeLinkedInSkills(linkedin.skills || []),
    ];
    state.projects = base.projects || [];
    state.certifications = base.certifications || [];
    state.experience = [
        ...(base.experience || []),
        ...normalizeLinkedInExperience(linkedin.experience || linkedin.experiences || linkedin.workExperience || linkedin.positions || []),
    ];
    state.education = [
        ...(base.education || []),
        ...((linkedin.education || []).map((item) => ({ ...item, source: 'linkedin' }))),
    ];
    state.githubRepos = base.githubRepos || [];
    state.githubActivity = cache.githubActivity || [];
    state.linkedinActivity = linkedin.activity || cache.linkedinActivity || [];
    state.linkedinHighlights = linkedin.highlights || [];
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

async function syncLinkedIn() {
    try {
        const linkedinUrl = process.env.LINKEDIN_DATA_URL;
        if (linkedinUrl) {
            const res = await fetch(linkedinUrl);
            if (!res.ok) throw new Error(`LinkedIn data fetch failed: ${res.status}`);
            const data = await res.json();
            state.linkedinHighlights = data.highlights || [];
            state.linkedinActivity = data.activity || [];
            const linkedinSkills = normalizeLinkedInSkills(data.skills || []);
            state.skills = [...state.skills.filter((item) => item.source !== 'linkedin'), ...linkedinSkills];
            state.experience = [
                ...normalizeLinkedInExperience(data.experience || data.experiences || data.workExperience || data.positions || []),
                ...(state.experience.filter((item) => item.source !== 'linkedin')),
            ].slice(0, 10);
            state.education = [
                ...(data.education || []).map((item) => ({ ...item, source: 'linkedin' })),
                ...(state.education.filter((item) => item.source !== 'linkedin')),
            ].slice(0, 10);
            return;
        }

        const linkedinData = await loadLinkedInData();
        state.linkedinHighlights = linkedinData.highlights || [];
        state.linkedinActivity = linkedinData.activity || [];
        const localLinkedInSkills = normalizeLinkedInSkills(linkedinData.skills || []);
        state.skills = [...state.skills.filter((item) => item.source !== 'linkedin'), ...localLinkedInSkills];
        state.experience = [
            ...normalizeLinkedInExperience(linkedinData.experience || linkedinData.experiences || linkedinData.workExperience || linkedinData.positions || []),
            ...(state.experience.filter((item) => item.source !== 'linkedin')),
        ].slice(0, 10);
        state.education = [
            ...(linkedinData.education || []).map((item) => ({ ...item, source: 'linkedin' })),
            ...(state.education.filter((item) => item.source !== 'linkedin')),
        ].slice(0, 10);
    } catch (error) {
        state.lastError = error.message;
    }
}

async function syncSources() {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
        await loadBaseData();
        await syncGitHub();
        await syncLinkedIn();
        state.syncedAt = new Date().toISOString();
        
        // Safe check for Vercel read-only permissions
        try {
            await fs.mkdir(dataDir, { recursive: true });
            await fs.writeFile(cachePath, JSON.stringify({
                syncedAt: state.syncedAt,
                githubActivity: state.githubActivity,
                linkedinActivity: state.linkedinActivity,
                githubStats: state.githubStats,
                lastError: state.lastError,
            }, null, 2));
        } catch (writeError) {
            console.warn("Disk writing skipped (Read-only Serverless Mode Enabled):", writeError.message);
        }
    } finally {
        syncInFlight = false;
    }
}

app.get('/', async (req, res) => {
    // If running on Vercel, just render the current static/cached state data
    // instead of blocking execution trying to parse file writes
    if (isVercel && state.syncedAt) {
        res.render('index', { state, titleCase: toTitleCase });
    } else {
        await syncSources();
        res.render('index', { state, titleCase: toTitleCase });
    }
});

app.get('/api/refresh', async (req, res) => {
    await syncSources();
    res.json({ ok: true, syncedAt: state.syncedAt, repositories: state.githubRepos.length, highlights: state.linkedinHighlights.length });
});

app.get('/api/linkedin-status', async (req, res) => {
    if (!state.syncedAt) await loadBaseData();
    const lastUpdated = state.linkedinActivity?.[0]?.at || state.syncedAt || new Date().toISOString();
    res.json({
        title: 'Professional profile active',
        text: `${state.linkedinHighlights.length} LinkedIn highlights and updates are ready to view.`,
        highlights: state.linkedinHighlights.length,
        lastUpdated,
    });
});

app.get('/api/linkedin-feed', async (req, res) => {
    if (!state.syncedAt) await loadBaseData();
    res.json({
        profile: state.profile,
        highlights: state.linkedinHighlights,
        activity: state.linkedinActivity,
        skills: state.skills.filter((item) => item.source === 'linkedin' || item.category),
        experience: state.experience.filter((item) => item.source === 'linkedin' || item.role || item.organization),
        education: state.education.filter((item) => item.source === 'linkedin' || item.degree || item.institution),
    });
});

app.post('/api/linkedin-update', async (req, res) => {
    const payload = req.body || {};
    const linkedInData = await loadLinkedInData();
    const entry = {
        title: payload.title || 'LinkedIn update',
        summary: payload.summary || 'A new professional update was added to the portfolio.',
        at: new Date().toISOString(),
    };

    const incomingExperience = normalizeLinkedInExperience(payload.experience || []);
    const experienceEntry = incomingExperience[0] || {
        role: payload.role || 'Professional update',
        organization: payload.organization || 'LinkedIn',
        period: payload.period || 'Now',
        summary: payload.summary || 'Added from sync form.',
        source: 'linkedin',
    };

    state.profile = { ...state.profile, ...(payload.profile || {}) };
    state.linkedinHighlights = [entry, ...state.linkedinHighlights].slice(0, 6);
    state.syncedAt = new Date().toISOString();

    res.json({ ok: true, update: entry, experience: experienceEntry });
});

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

// Disable the polling loop completely on Vercel architectures
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
