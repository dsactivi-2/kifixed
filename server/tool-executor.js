const github = require('./github-client');
const linear = require('./linear-client');

/**
 * Get all available tools based on configured credentials
 * @param {string} githubToken - GitHub personal access token
 * @param {string} linearApiKey - Linear API key
 * @returns {Array} Array of tool definitions
 */
function getAvailableTools(githubToken, linearApiKey) {
  const tools = [];

  // Add GitHub tools if token is configured
  if (githubToken) {
    tools.push(...github.tools);
  }

  // Add Linear tools if API key is configured
  if (linearApiKey) {
    tools.push(...linear.tools);
  }

  return tools;
}

/**
 * Execute a single tool call
 * @param {Object} toolCall - Tool call object with function name and arguments
 * @param {string} githubToken - GitHub token
 * @param {string} linearApiKey - Linear API key
 * @returns {Promise<string>} Tool execution result as JSON string
 */
async function executeTool(toolCall, githubToken, linearApiKey) {
  const functionName = toolCall.function.name;
  let args = toolCall.function.arguments;

  // Parse arguments if they're a string
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (error) {
      console.error(`[Tools] Failed to parse arguments for ${functionName}:`, error.message);
      return JSON.stringify({ error: 'Invalid JSON arguments' });
    }
  }

  // Log the tool execution
  const argsPreview = JSON.stringify(args).substring(0, 100);
  console.log(`[Tools] Executing: ${functionName}(${argsPreview}${argsPreview.length >= 100 ? '...' : ''})`);

  try {
    let result;

    // Route to appropriate client based on function prefix
    if (functionName.startsWith('github_')) {
      if (!githubToken) {
        throw new Error('GitHub token not configured');
      }
      result = await github.executeFunction(functionName, args, githubToken);
    } else if (functionName.startsWith('linear_')) {
      if (!linearApiKey) {
        throw new Error('Linear API key not configured');
      }
      result = await linear.executeFunction(functionName, args, linearApiKey);
    } else {
      throw new Error(`Unknown tool: ${functionName}`);
    }

    // Convert result to string if it's an object
    const resultString = typeof result === 'string' ? result : JSON.stringify(result);

    // Log truncated result
    const resultPreview = resultString.substring(0, 200);
    console.log(`[Tools] Result from ${functionName}: ${resultPreview}${resultPreview.length >= 200 ? '...' : ''}`);

    return resultString;
  } catch (error) {
    console.error(`[Tools] Error executing ${functionName}:`, error.message);
    return JSON.stringify({
      error: error.message,
      tool: functionName
    });
  }
}

/**
 * Process multiple tool calls in parallel
 * @param {Array} toolCalls - Array of tool call objects
 * @param {string} githubToken - GitHub token
 * @param {string} linearApiKey - Linear API key
 * @returns {Promise<Array>} Array of tool result objects formatted for Ollama
 */
async function processToolCalls(toolCalls, githubToken, linearApiKey) {
  console.log(`[Tools] Processing ${toolCalls.length} tool call(s)...`);

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const content = await executeTool(toolCall, githubToken, linearApiKey);
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content,
      };
    })
  );

  return results;
}

/**
 * Main tool-calling loop with Ollama
 * @param {Object} ollamaClient - Axios instance for Ollama API
 * @param {string} model - Model name
 * @param {Array} messages - Initial conversation messages
 * @param {Array} tools - Available tool definitions
 * @param {Object} options - Chat options (temperature, maxTokens)
 * @param {string} githubToken - GitHub token
 * @param {string} linearApiKey - Linear API key
 * @param {number} maxIterations - Maximum tool calling iterations (default: 10)
 * @returns {Promise<Object>} Final response with message, tool results, and metadata
 */
async function chatWithTools(
  ollamaClient,
  model,
  messages,
  tools,
  options,
  githubToken,
  linearApiKey,
  maxIterations = 10
) {
  let currentMessages = [...messages];
  const allToolResults = [];
  let iterations = 0;

  console.log(`[Tools] Starting chat with tools loop (max ${maxIterations} iterations)...`);

  while (iterations < maxIterations) {
    iterations++;
    console.log(`[Tools] Iteration ${iterations}/${maxIterations}`);

    const payload = {
      model,
      messages: currentMessages,
      stream: false,
      tools: tools.length > 0 ? tools : undefined,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    try {
      const response = await ollamaClient.post('/api/chat', payload);
      const assistantMsg = response.data.message;

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        console.log(`[Tools] Assistant requested ${assistantMsg.tool_calls.length} tool call(s)`);

        // Add assistant message with tool calls
        currentMessages.push(assistantMsg);

        // Execute tools in parallel
        const results = await processToolCalls(assistantMsg.tool_calls, githubToken, linearApiKey);
        allToolResults.push(...results);

        // Add tool results to messages
        for (const result of results) {
          currentMessages.push({
            role: 'tool',
            content: result.content,
          });
        }
      } else {
        // No tool calls - we have the final answer
        console.log(`[Tools] Chat completed after ${iterations} iteration(s)`);
        return {
          message: assistantMsg.content || '',
          toolResults: allToolResults,
          iterations,
          totalDuration: response.data.total_duration,
          evalCount: response.data.eval_count,
        };
      }
    } catch (error) {
      console.error(`[Tools] Error in iteration ${iterations}:`, error.message);
      throw error;
    }
  }

  // Max iterations reached
  console.warn(`[Tools] Max iterations (${maxIterations}) reached without final answer`);
  const lastMessage = currentMessages[currentMessages.length - 1];
  return {
    message: lastMessage?.content || 'Max tool iterations reached',
    toolResults: allToolResults,
    iterations,
    maxIterationsReached: true,
  };
}

module.exports = {
  getAvailableTools,
  executeTool,
  processToolCalls,
  chatWithTools,
};
