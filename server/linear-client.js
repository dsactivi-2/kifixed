const axios = require('axios');

const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Helper function to make GraphQL requests to Linear API
 * @param {string} apiKey - Linear API key
 * @param {string} query - GraphQL query or mutation
 * @param {object} variables - GraphQL variables
 * @returns {Promise<object>} - Response data
 */
async function graphql(apiKey, query, variables = {}) {
  try {
    const response = await axios.post(
      LINEAR_API_URL,
      {
        query,
        variables
      },
      {
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.errors) {
      throw new Error(response.data.errors[0].message);
    }

    return response.data.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Linear API error: ${error.response.status} - ${error.response.statusText}`);
    }
    throw error;
  }
}

/**
 * List all teams
 */
async function linear_list_teams(apiKey) {
  try {
    const query = `{
      teams {
        nodes {
          id
          name
          key
          description
        }
      }
    }`;

    const data = await graphql(apiKey, query);
    return data.teams.nodes;
  } catch (error) {
    return { error: `Failed to list teams: ${error.message}` };
  }
}

/**
 * List projects, optionally filtered by team
 */
async function linear_list_projects(apiKey, teamId = null) {
  try {
    let query, variables;

    if (teamId) {
      query = `query($teamId: String) {
        projects(filter: { teams: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            description
            state
            startDate
            targetDate
          }
        }
      }`;
      variables = { teamId };
    } else {
      query = `{
        projects {
          nodes {
            id
            name
            description
            state
            startDate
            targetDate
          }
        }
      }`;
      variables = {};
    }

    const data = await graphql(apiKey, query, variables);
    return data.projects.nodes;
  } catch (error) {
    return { error: `Failed to list projects: ${error.message}` };
  }
}

/**
 * List issues with optional filters
 */
async function linear_list_issues(apiKey, teamId = null, state = null, limit = 50) {
  try {
    const filter = {};

    if (teamId) {
      filter.team = { id: { eq: teamId } };
    }

    if (state) {
      filter.state = { name: { eq: state } };
    }

    const query = `query($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          state {
            name
          }
          priority
          priorityLabel
          assignee {
            name
          }
          project {
            name
          }
          createdAt
          updatedAt
        }
      }
    }`;

    const variables = {
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      first: limit
    };

    const data = await graphql(apiKey, query, variables);
    return data.issues.nodes;
  } catch (error) {
    return { error: `Failed to list issues: ${error.message}` };
  }
}

/**
 * Search issues by query term
 */
async function linear_search_issues(apiKey, query) {
  try {
    const gqlQuery = `query($query: String!) {
      searchIssues(term: $query, first: 20) {
        nodes {
          id
          identifier
          title
          description
          state {
            name
          }
          priority
          priorityLabel
          assignee {
            name
          }
        }
      }
    }`;

    const data = await graphql(apiKey, gqlQuery, { query });
    return data.searchIssues.nodes;
  } catch (error) {
    return { error: `Failed to search issues: ${error.message}` };
  }
}

/**
 * Create a new issue
 */
async function linear_create_issue(apiKey, teamId, title, description = '', priority = 0, projectId = null) {
  try {
    const input = {
      teamId,
      title,
      description,
      priority
    };

    if (projectId) {
      input.projectId = projectId;
    }

    const mutation = `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }`;

    const data = await graphql(apiKey, mutation, { input });
    return data.issueCreate;
  } catch (error) {
    return { error: `Failed to create issue: ${error.message}` };
  }
}

/**
 * Update an existing issue
 */
async function linear_update_issue(apiKey, issueId, title = null, description = null, priority = null, stateId = null) {
  try {
    const input = {};

    if (title !== null) input.title = title;
    if (description !== null) input.description = description;
    if (priority !== null) input.priority = priority;
    if (stateId !== null) input.stateId = stateId;

    const mutation = `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          state {
            name
          }
        }
      }
    }`;

    const data = await graphql(apiKey, mutation, { id: issueId, input });
    return data.issueUpdate;
  } catch (error) {
    return { error: `Failed to update issue: ${error.message}` };
  }
}

/**
 * List workflow states for a team
 */
async function linear_list_states(apiKey, teamId) {
  try {
    const query = `query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes {
          id
          name
          type
          position
        }
      }
    }`;

    const data = await graphql(apiKey, query, { teamId });
    return data.workflowStates.nodes;
  } catch (error) {
    return { error: `Failed to list workflow states: ${error.message}` };
  }
}

/**
 * Ollama-compatible tool definitions
 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'linear_list_teams',
      description: 'List all teams in Linear workspace',
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
      name: 'linear_list_projects',
      description: 'List projects from Linear, optionally filtered by team',
      parameters: {
        type: 'object',
        properties: {
          teamId: {
            type: 'string',
            description: 'Team ID to filter projects by (optional)'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linear_list_issues',
      description: 'List issues from Linear project management',
      parameters: {
        type: 'object',
        properties: {
          teamId: {
            type: 'string',
            description: 'Team ID to filter by'
          },
          state: {
            type: 'string',
            description: 'Filter by state name (e.g., "Todo", "In Progress", "Done")'
          },
          limit: {
            type: 'number',
            description: 'Max results (default 50)'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linear_search_issues',
      description: 'Search issues in Linear by query term',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to find issues'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linear_create_issue',
      description: 'Create a new issue in Linear',
      parameters: {
        type: 'object',
        properties: {
          teamId: {
            type: 'string',
            description: 'Team ID where the issue will be created'
          },
          title: {
            type: 'string',
            description: 'Issue title'
          },
          description: {
            type: 'string',
            description: 'Issue description (optional)'
          },
          priority: {
            type: 'number',
            description: 'Priority level: 0=none, 1=urgent, 2=high, 3=medium, 4=low (default 0)'
          },
          projectId: {
            type: 'string',
            description: 'Project ID to assign the issue to (optional)'
          }
        },
        required: ['teamId', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linear_update_issue',
      description: 'Update an existing issue in Linear',
      parameters: {
        type: 'object',
        properties: {
          issueId: {
            type: 'string',
            description: 'Issue ID to update'
          },
          title: {
            type: 'string',
            description: 'New title (optional)'
          },
          description: {
            type: 'string',
            description: 'New description (optional)'
          },
          priority: {
            type: 'number',
            description: 'New priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low (optional)'
          },
          stateId: {
            type: 'string',
            description: 'New workflow state ID (optional)'
          }
        },
        required: ['issueId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linear_list_states',
      description: 'List workflow states for a team in Linear',
      parameters: {
        type: 'object',
        properties: {
          teamId: {
            type: 'string',
            description: 'Team ID to get workflow states for'
          }
        },
        required: ['teamId']
      }
    }
  }
];

/**
 * Execute a Linear function by name
 * @param {string} name - Function name
 * @param {object} args - Function arguments
 * @param {string} apiKey - Linear API key
 * @returns {Promise<object>} - Function result
 */
async function executeFunction(name, args, apiKey) {
  const functionMap = {
    linear_list_teams: () => linear_list_teams(apiKey),
    linear_list_projects: () => linear_list_projects(apiKey, args.teamId),
    linear_list_issues: () => linear_list_issues(apiKey, args.teamId, args.state, args.limit),
    linear_search_issues: () => linear_search_issues(apiKey, args.query),
    linear_create_issue: () => linear_create_issue(apiKey, args.teamId, args.title, args.description, args.priority, args.projectId),
    linear_update_issue: () => linear_update_issue(apiKey, args.issueId, args.title, args.description, args.priority, args.stateId),
    linear_list_states: () => linear_list_states(apiKey, args.teamId)
  };

  const func = functionMap[name];
  if (!func) {
    return { error: `Unknown function: ${name}` };
  }

  try {
    return await func();
  } catch (error) {
    return { error: `Function execution failed: ${error.message}` };
  }
}

module.exports = {
  tools,
  executeFunction
};
