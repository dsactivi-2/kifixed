const axios = require('axios');

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Create axios instance with GitHub API headers
 * @param {string} token - GitHub personal access token
 * @returns {object} Axios instance
 */
function createGitHubClient(token) {
  return axios.create({
    baseURL: GITHUB_API_BASE,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Letta-Agent-Server'
    }
  });
}

/**
 * List all repositories of the authenticated user
 * @param {string} token - GitHub personal access token
 * @returns {Promise<object>} Repository list or error
 */
async function github_list_repos(token) {
  try {
    const client = createGitHubClient(token);
    const response = await client.get('/user/repos', {
      params: { per_page: 100, sort: 'updated' }
    });
    return { repos: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Search GitHub repositories
 * @param {string} token - GitHub personal access token
 * @param {string} query - Search query
 * @returns {Promise<object>} Search results or error
 */
async function github_search_repos(token, query) {
  try {
    const client = createGitHubClient(token);
    const response = await client.get('/search/repositories', {
      params: { q: query }
    });
    return { results: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Get file content from a GitHub repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} path - File path
 * @param {string} ref - Branch/commit reference (optional)
 * @returns {Promise<object>} File content or error
 */
async function github_get_file(token, repo, path, ref = 'main') {
  try {
    const client = createGitHubClient(token);
    const params = ref ? { ref } : {};
    const response = await client.get(`/repos/${repo}/contents/${path}`, { params });

    if (response.data.content) {
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      return {
        content,
        sha: response.data.sha,
        size: response.data.size,
        path: response.data.path
      };
    }
    return { error: 'File content not found' };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * List files in a directory
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} path - Directory path
 * @param {string} ref - Branch/commit reference (optional)
 * @returns {Promise<object>} Directory listing or error
 */
async function github_list_files(token, repo, path = '', ref = 'main') {
  try {
    const client = createGitHubClient(token);
    const params = ref ? { ref } : {};
    const response = await client.get(`/repos/${repo}/contents/${path}`, { params });
    return { files: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Search code in GitHub repositories
 * @param {string} token - GitHub personal access token
 * @param {string} query - Search query
 * @param {string} repo - Repository name to filter (optional)
 * @returns {Promise<object>} Search results or error
 */
async function github_search_code(token, query, repo = null) {
  try {
    const client = createGitHubClient(token);
    const searchQuery = repo ? `${query} repo:${repo}` : query;
    const response = await client.get('/search/code', {
      params: { q: searchQuery }
    });
    return { results: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * List issues in a repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} state - Issue state (open, closed, all)
 * @returns {Promise<object>} Issues list or error
 */
async function github_list_issues(token, repo, state = 'open') {
  try {
    const client = createGitHubClient(token);
    const response = await client.get(`/repos/${repo}/issues`, {
      params: { state }
    });
    return { issues: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Create a new issue in a repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} title - Issue title
 * @param {string} body - Issue body/description
 * @param {Array<string>} labels - Issue labels (optional)
 * @returns {Promise<object>} Created issue or error
 */
async function github_create_issue(token, repo, title, body, labels = []) {
  try {
    const client = createGitHubClient(token);
    const response = await client.post(`/repos/${repo}/issues`, {
      title,
      body,
      labels
    });
    return { issue: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * List pull requests in a repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} state - PR state (open, closed, all)
 * @returns {Promise<object>} Pull requests list or error
 */
async function github_list_pulls(token, repo, state = 'open') {
  try {
    const client = createGitHubClient(token);
    const response = await client.get(`/repos/${repo}/pulls`, {
      params: { state }
    });
    return { pulls: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Get repository details
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @returns {Promise<object>} Repository details or error
 */
async function github_get_repo(token, repo) {
  try {
    const client = createGitHubClient(token);
    const response = await client.get(`/repos/${repo}`);
    return { repository: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * List branches in a repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @returns {Promise<object>} Branches list or error
 */
async function github_list_branches(token, repo) {
  try {
    const client = createGitHubClient(token);
    const response = await client.get(`/repos/${repo}/branches`);
    return { branches: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Create or update a file in a repository
 * @param {string} token - GitHub personal access token
 * @param {string} repo - Repository name (owner/repo)
 * @param {string} path - File path
 * @param {string} content - File content (will be base64 encoded)
 * @param {string} message - Commit message
 * @param {string} sha - File SHA (required for updates, null for creation)
 * @param {string} branch - Branch name (optional, defaults to repo default)
 * @returns {Promise<object>} File operation result or error
 */
async function github_create_or_update_file(token, repo, path, content, message, sha = null, branch = null) {
  try {
    const client = createGitHubClient(token);
    const encodedContent = Buffer.from(content).toString('base64');
    const data = {
      message,
      content: encodedContent
    };

    if (sha) {
      data.sha = sha;
    }
    if (branch) {
      data.branch = branch;
    }

    const response = await client.put(`/repos/${repo}/contents/${path}`, data);
    return { result: response.data };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
}

/**
 * Ollama-compatible tool definitions for function calling
 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: 'List all GitHub repositories of the authenticated user, sorted by recent updates',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_search_repos',
      description: 'Search GitHub repositories by query string',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "language:javascript stars:>100")'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_get_file',
      description: 'Get the content of a specific file from a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          path: {
            type: 'string',
            description: 'File path within the repository'
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit reference (default: "main")'
          }
        },
        required: ['repo', 'path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_files',
      description: 'List files and directories in a repository path',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          path: {
            type: 'string',
            description: 'Directory path (empty string for root)'
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit reference (default: "main")'
          }
        },
        required: ['repo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_search_code',
      description: 'Search code across GitHub repositories',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Code search query'
          },
          repo: {
            type: 'string',
            description: 'Optional repository filter in format "owner/repo"'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_issues',
      description: 'List issues in a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          state: {
            type: 'string',
            description: 'Issue state: "open", "closed", or "all" (default: "open")',
            enum: ['open', 'closed', 'all']
          }
        },
        required: ['repo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_create_issue',
      description: 'Create a new issue in a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          title: {
            type: 'string',
            description: 'Issue title'
          },
          body: {
            type: 'string',
            description: 'Issue body/description'
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of label names to apply'
          }
        },
        required: ['repo', 'title', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_pulls',
      description: 'List pull requests in a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          state: {
            type: 'string',
            description: 'PR state: "open", "closed", or "all" (default: "open")',
            enum: ['open', 'closed', 'all']
          }
        },
        required: ['repo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_get_repo',
      description: 'Get detailed information about a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          }
        },
        required: ['repo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_branches',
      description: 'List all branches in a GitHub repository',
      parameters: {
        type: 'object',
      properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          }
        },
        required: ['repo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_create_or_update_file',
      description: 'Create a new file or update an existing file in a GitHub repository',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository name in format "owner/repo"'
          },
          path: {
            type: 'string',
            description: 'File path in the repository'
          },
          content: {
            type: 'string',
            description: 'File content (will be automatically base64 encoded)'
          },
          message: {
            type: 'string',
            description: 'Commit message'
          },
          sha: {
            type: 'string',
            description: 'File SHA (required for updates, omit for new files)'
          },
          branch: {
            type: 'string',
            description: 'Branch name (optional, uses repo default if not specified)'
          }
        },
        required: ['repo', 'path', 'content', 'message']
      }
    }
  }
];

/**
 * Execute a GitHub function by name
 * @param {string} name - Function name
 * @param {object} args - Function arguments
 * @param {string} token - GitHub personal access token
 * @returns {Promise<object>} Function result or error
 */
async function executeFunction(name, args, token) {
  try {
    switch (name) {
      case 'github_list_repos':
        return await github_list_repos(token);

      case 'github_search_repos':
        return await github_search_repos(token, args.query);

      case 'github_get_file':
        return await github_get_file(token, args.repo, args.path, args.ref);

      case 'github_list_files':
        return await github_list_files(token, args.repo, args.path, args.ref);

      case 'github_search_code':
        return await github_search_code(token, args.query, args.repo);

      case 'github_list_issues':
        return await github_list_issues(token, args.repo, args.state);

      case 'github_create_issue':
        return await github_create_issue(token, args.repo, args.title, args.body, args.labels);

      case 'github_list_pulls':
        return await github_list_pulls(token, args.repo, args.state);

      case 'github_get_repo':
        return await github_get_repo(token, args.repo);

      case 'github_list_branches':
        return await github_list_branches(token, args.repo);

      case 'github_create_or_update_file':
        return await github_create_or_update_file(
          token,
          args.repo,
          args.path,
          args.content,
          args.message,
          args.sha,
          args.branch
        );

      default:
        return { error: `Unknown function: ${name}` };
    }
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = {
  tools,
  executeFunction
};
