const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT =  3000;
const RIBBON_API_KEY = process.env.RIBBON_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RIBBON_BASE_URL = 'https://app.ribbon.ai/be-api/v1';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Serve homepage by default
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/homepage.html');
});

// Store interview sessions (in production, use a database)
const sessions = new Map();

// Helper function to generate code analysis questions using Gemini AI
async function generateCodeQuestions(code, language) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  
  const prompt = `
You are an expert code reviewer helping assess code understanding. Analyze the following ${language} code and generate 6 specific, targeted questions that will help determine if the person truly understands their own code.

**Code to analyze:**
\`\`\`${language}
${code}
\`\`\`

**Requirements for questions:**
1. The first question should always be what the overall code does (not what a specific part or function does for the whole but what the code as a whole does) and its main purpose (can be paraphrased). 
2. The second question should be how did you achieve your overall goal you wanted through the code and why did you choose this specific implementation (can also be paraphrased).
3. Questions should be SPECIFIC to this exact code, not generic
4. Focus on testing deep understanding of design decisions, logic, and implementation details
5. Questions should reveal if someone actually wrote the code vs. just copied it
6. Include questions about specific functions, variables, or logic patterns in THIS code
7. Ask about potential issues, edge cases, or improvements specific to THIS implementation
8. Keep questions focused strictly on the code - no personal or unrelated topics
9. Frame questions as friendly code review discussion, not job interview questions

**Question types to include:**
- Ask about specific variable names, function names, or logic choices in their code
- Question specific implementation decisions they made
- Ask about potential bugs or edge cases in their specific code
- Test understanding of how specific parts of their code work together
- Ask about alternatives to their specific approach
- Question specific error handling or lack thereof in their code

**Output format:**
Return exactly 6 questions as a JSON array of strings. Each question should reference specific elements from the provided code.

Example format:
["Question 1 about specific code element", "Question 2 about specific implementation", ...]

Make the questions conversational and friendly, like a code review discussion. Focus on "Can you explain..." and "What happens if..." questions about their specific code.
`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.text();
  
  // Try to extract JSON array from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    const questions = JSON.parse(jsonMatch[0]);
    if (Array.isArray(questions) && questions.length > 0) {
      console.log(`Generated ${questions.length} tailored questions for ${language} code`);
      return questions;
    }
  }
  
  throw new Error('Failed to generate valid questions from Gemini API');
}

// Create interview flow for code review
async function createInterviewFlow(code, language, studentName) {
  try {
    console.log(`Creating interview flow for ${studentName} - ${language}`);
    const questions = await generateCodeQuestions(code, language);
    console.log(`Generated questions:`, questions);
    
    const flowData = {
      org_name: "Code Buddy",
      title: `Code Understanding Assessment - ${language}`,
      questions: questions,
      interview_type: "recruitment",
      is_video_enabled: true
    };
    
    console.log(`Sending flow data to Ribbon API:`, JSON.stringify(flowData, null, 2));
    
    const response = await axios.post(`${RIBBON_BASE_URL}/interview-flows`, flowData, {
      headers: {
        'Authorization': `Bearer ${RIBBON_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log(`Interview flow created successfully:`, response.data);
    return response.data.interview_flow_id;
  } catch (error) {
    console.error('Error creating interview flow:', error.response?.data || error.message);
    console.error('Full error response:', error.response);
    throw error;
  }
}

// Create interview session
async function createInterview(interviewFlowId, studentEmail, studentName) {
  try {
    const [firstName, ...lastNameParts] = studentName.split(' ');
    const lastName = lastNameParts.join(' ') || '';
    
    const response = await axios.post(`${RIBBON_BASE_URL}/interviews?limit=1000`, {
      interview_flow_id: interviewFlowId,
      interviewee_email_address: studentEmail,
      interviewee_first_name: firstName,
      interviewee_last_name: lastName
    }, {
      headers: {
        'Authorization': `Bearer ${RIBBON_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Error creating interview:', error.response?.data || error.message);
    throw error;
  }
}

// Get interview results
async function getInterviewResults(interviewId) {
  try {
    console.log(`Making request to Ribbon API for interviews...`);
    console.log(`Looking for interview ID: ${interviewId}`);
    
    const response = await axios.get(`${RIBBON_BASE_URL}/interviews?limit=1000`, {
      headers: {
        'Authorization': `Bearer ${RIBBON_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    
    console.log(`Ribbon API response received, ${response.data.interviews?.length || 0} interviews found`);
    
    // Log all interview IDs for debugging
    if (response.data.interviews) {
      console.log('Available interview IDs:', response.data.interviews.map(i => i.interview_data?.interview_id || i.interview_id));
      
      // Log the full structure of the first interview for debugging
      if (response.data.interviews.length > 0) {
        console.log('Sample interview structure:', JSON.stringify(response.data.interviews[0], null, 2));
      }
    }
    
    const interview = response.data.interviews?.find(
      interview => (interview.interview_data?.interview_id || interview.interview_id) === interviewId
    );
    
    if (interview) {
      // Handle nested structure: status might be at root level or in interview_data
      const interviewData = interview.interview_data || interview;
      const status = interview.status || interview.interview_data?.status;
      const flowId = interview.interview_flow_id || interview.interview_data?.interview_flow_id;
      
      console.log(`Found interview with status: ${status}`);
      console.log(`Interview flow ID: ${flowId}`);
      
      // Return a normalized structure with status at the top level
      const normalizedData = {
        ...interviewData,
        status: status,
        interview_flow_id: flowId,
        interview_id: interviewData.interview_id || interview.interview_id
      };
      
      return normalizedData;
    } else {
      console.log(`Interview with ID ${interviewId} not found in API response`);
      console.log(`Searched for: ${interviewId}`);
    }
    
    return null;
  } catch (error) {
    console.error('Error getting interview results:', error.response?.data || error.message);
    console.error('Full error:', error);
    throw error;
  }
}

// Analyze interview for AI detection using Gemini AI
async function analyzeForAIDetection(interviewData, originalCode) {
  if (!interviewData || !interviewData.transcript) {
    return {
      score: 0,
      confidence: 'unknown',
      aiLikelihood: 'unknown',
      reasoning: 'No interview data available',
      geminiAnalysis: false
    };
  }



  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
You are an expert at detecting whether code was written by a human or generated by AI tools like ChatGPT, Claude, etc.

Analyze the following code and interview transcript to determine if the code was likely written by AI or by a human.

**Original Code:**
\`\`\`
${originalCode || 'Code not available'}
\`\`\`

**Interview Transcript:**
"${interviewData.transcript}"

**Analysis Instructions:**
1. **Code Analysis:** Look for signs of AI-generated code:
   - Overly perfect structure and formatting
   - Generic variable names (e.g., data, result, temp)
   - Excessive comments or no comments at all
   - Lack of personal coding style or quirks
   - Too-perfect error handling
   - Generic solutions without specific optimizations

2. **Interview Analysis:** Evaluate the responses for:
   - **Hesitation vs Confidence:** Does the person seem uncertain about their own code?
   - **Deep Understanding:** Can they explain WHY they made specific decisions?
   - **Personal Experience:** Do they mention struggles, debugging, or iterations?
   - **Specific Knowledge:** Can they discuss edge cases, limitations, or alternative approaches?
   - **Generic Responses:** Are answers too perfect or could apply to any code?
   - **Technical Depth:** Do they understand the underlying concepts or just surface-level?
   - **Link with Code:** Do their explanations match the code structure and logic?

3. **Red Flags for AI Generation:**
   - Can't explain specific design choices
   - Hesitant when asked about debugging process
   - Generic explanations that could apply to any code
   - No mention of personal coding challenges or iterations
   - Perfect explanations without personal touch
   - Unable to discuss what they would change or improve

4. **Human Indicators:**
   - Personal anecdotes about writing the code
   - Mentions of debugging, struggles, or multiple attempts
   - Specific reasons for design decisions
   - Knowledge of limitations or potential improvements
   - Coding style quirks or personal preferences
   - Ability to discuss alternative approaches they considered

**Required Output Format (JSON only):**
{
  "score": [number from 0-100, where 0=definitely AI-generated, 100=definitely human-written],
  "confidence": "[low/medium/high/indecisive]",
  "reasoning": "[detailed explanation of your analysis]",
  "redFlags": ["list of specific concerns suggesting AI generation"],
  "humanIndicators": ["list of specific signs suggesting human authorship"],
  "keyObservations": ["important patterns you noticed in code or interview"],
  "indecisive": [true/false, true if there is not enough information to make a confident judgment, or if the code is so basic that either AI or human could have written it],
  "suspiciousPhrases": [
    {
      "text": "exact suspicious phrase",
      "type": "code" | "transcript",
      "reason": "why this phrase is suspicious"
    },
    ...
  ]
}

In addition to your previous instructions, scan both the code and transcript for any highly suspicious phrases or patterns that strongly suggest AI generation (e.g., generic explanations, overly formal language, repeated AI-like patterns, or code comments that match known AI output). For each, add an object to "suspiciousPhrases" with the exact phrase, whether it was found in the code or transcript, and a brief reason.
`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    console.log('Gemini AI Response:', text); // Debug log
    
    // Try to extract JSON from the response
    let geminiAnalysis;
    try {
      // Look for JSON in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        geminiAnalysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.log('Could not parse Gemini JSON response, creating structured response from text');
      geminiAnalysis = {
        score: extractScoreFromText(text),
        confidence: extractConfidenceFromText(text),
        reasoning: text,
        redFlags: [],
        humanIndicators: [],
        keyObservations: []
      };
    }

    // Ensure score is within bounds
    geminiAnalysis.score = Math.max(0, Math.min(100, geminiAnalysis.score || 50));

    // Determine AI likelihood based on score and indecisive/confidence
    let aiLikelihood;
    if (geminiAnalysis.indecisive || geminiAnalysis.confidence === 'indecisive') {
      aiLikelihood = 'indecisive';
    } else if (geminiAnalysis.score >= 70) {
      aiLikelihood = 'likely human-written';
    } else if (geminiAnalysis.score >= 50) {
      aiLikelihood = 'possibly human-written';
    } else if (geminiAnalysis.score >= 30) {
      aiLikelihood = 'possibly AI-generated';
    } else {
      aiLikelihood = 'likely AI-generated';
    }

    return {
      score: geminiAnalysis.score,
      confidence: geminiAnalysis.confidence || 'medium',
      aiLikelihood,
      reasoning: geminiAnalysis.reasoning || 'Analysis completed',
      redFlags: geminiAnalysis.redFlags || [],
      humanIndicators: geminiAnalysis.humanIndicators || [],
      keyObservations: geminiAnalysis.keyObservations || [],
      geminiAnalysis: true,
      transcriptLength: interviewData.transcript.length,
      suspiciousPhrases: geminiAnalysis.suspiciousPhrases || [],
    };

  } catch (error) {
    console.error('Gemini AI analysis failed:', error);
    throw error; // Don't fall back, just throw the error
  }
}

// Helper functions for text parsing
function extractScoreFromText(text) {
  const scoreMatch = text.match(/score[\":\s]*(\d+)/i);
  if (scoreMatch) {
    return parseInt(scoreMatch[1]);
  }
  
  // Look for percentage
  const percentMatch = text.match(/(\d+)%/);
  if (percentMatch) {
    return parseInt(percentMatch[1]);
  }
  
  return 50; // Default neutral score
}

function extractConfidenceFromText(text) {
  if (text.toLowerCase().includes('high confidence') || text.toLowerCase().includes('very confident')) {
    return 'high';
  } else if (text.toLowerCase().includes('low confidence') || text.toLowerCase().includes('uncertain')) {
    return 'low';
  }
  return 'medium';
}

// Routes

// Submit code and create interview
app.post('/api/submit-code', async (req, res) => {
  try {
    const { code, language, studentName, studentEmail } = req.body;
    
    if (!code || !language || !studentName || !studentEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Create interview flow
    const interviewFlowId = await createInterviewFlow(code, language, studentName);
    
    // Create interview
    const interview = await createInterview(interviewFlowId, studentEmail, studentName);
    
    // Store session data
    const sessionId = interview.interview_id;
    sessions.set(sessionId, {
      code,
      language,
      studentName,
      studentEmail,
      interviewFlowId,
      createdAt: new Date()
    });
    
    res.json({
      success: true,
      sessionId,
      interviewLink: interview.interview_link,
      interviewId: interview.interview_id
    });
    
  } catch (error) {
    console.error('Error in submit-code:', error);
    res.status(500).json({ 
      error: 'Failed to create interview',
      details: error.message 
    });
  }
});

// Get interview status and results
app.get('/api/interview-status/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    console.log(`\n=== Checking interview status for: ${interviewId} ===`);
    
    const session = sessions.get(interviewId);
    
    // First, try to get interview data from Ribbon API
    console.log(`Getting interview results from Ribbon API...`);
    const interviewData = await getInterviewResults(interviewId);
    
    if (!interviewData) {
      console.log(`⏳ No interview data found - interview may not be completed yet`);
      return res.json({ 
        status: 'pending',
        message: 'Interview not completed yet. Please complete the interview and wait a moment.' 
      });
    }
    
    console.log(`📊 Interview data found, status: ${interviewData.status}`);
    
    if (interviewData.status !== 'completed') {
      console.log(`⏳ Interview status is: ${interviewData.status}`);
      return res.json({ 
        status: interviewData.status,
        message: `Interview status: ${interviewData.status}. Please wait for completion.` 
      });
    }
    
    // If no session data (server restarted), create minimal analysis
    if (!session) {
      console.log(`⚠️ Session not found, but interview completed. Creating analysis without original code context.`);
      
      // Analyze without original code (Gemini can still analyze the transcript)
      const analysis = await analyzeForAIDetection(interviewData, null);
      
      res.json({
        status: 'completed',
        analysis,
        transcript: interviewData.transcript,
        originalCode: null,
        studentInfo: {
          name: 'Unknown Student',
          language: 'Unknown'
        },
        note: 'Session data was lost. Analysis performed without original code context.'
      });
      return;
    }
    
    // Normal case with session data
    console.log(`✅ Session found for ${session.studentName}`);
    console.log(`🔍 Analyzing completed interview with Gemini AI...`);
    const analysis = await analyzeForAIDetection(interviewData, session.code);
    console.log(`✅ Analysis complete - Score: ${analysis.score}`);
    
    res.json({
      status: 'completed',
      analysis,
      transcript: interviewData.transcript,
      originalCode: session.code,
      studentInfo: {
        name: session.studentName,
        language: session.language
      }
    });
    
  } catch (error) {
    console.error('❌ Error in interview-status:', error);
    console.error('Error details:', error.response?.data || error.message);
    
    // Send a more user-friendly error response
    const errorMessage = error.response?.data?.message || error.message || 'Unknown error occurred';
    res.status(500).json({ 
      error: 'Failed to get interview status',
      details: errorMessage,
      suggestion: 'Please try again in a few moments. If the problem persists, check if the interview was completed successfully.'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test Ribbon API connection
app.get('/api/test-ribbon', async (req, res) => {
  try {
    console.log('Testing Ribbon API connection...');
    const response = await axios.get(`${RIBBON_BASE_URL}/interviews`, {
      headers: {
        'Authorization': `Bearer ${RIBBON_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    
    res.json({ 
      status: 'OK', 
      message: 'Ribbon API connection successful',
      interviewCount: response.data.interviews?.length || 0,
      interviews: response.data.interviews?.map(i => ({
        id: i.interview_data?.interview_id || i.interview_id,
        flowId: i.interview_data?.interview_flow_id || i.interview_flow_id,
        status: i.interview_data?.status || i.status
      })) || []
    });
  } catch (error) {
    console.error('Ribbon API test failed:', error.response?.data || error.message);
    res.status(500).json({ 
      status: 'ERROR', 
      message: 'Ribbon API connection failed',
      error: error.response?.data || error.message 
    });
  }
});

// Manual interview check - useful for debugging
app.get('/api/manual-check/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    console.log(`Manual check for interview: ${interviewId}`);
    
    const interviewData = await getInterviewResults(interviewId);
    
    if (!interviewData) {
      return res.json({
        found: false,
        message: 'Interview not found in Ribbon API'
      });
    }
    
    // Create analysis even without session data
    const analysis = analyzeForAIDetection(interviewData, null);
    
    res.json({
      found: true,
      interviewId: interviewData.interview_id,
      flowId: interviewData.interview_flow_id,
      status: interviewData.status,
      analysis,
      transcript: interviewData.transcript,
      note: 'Manual check - no original code context available'
    });
    
  } catch (error) {
    console.error('Manual check failed:', error);
    res.status(500).json({
      found: false,
      error: error.message
    });
  }
});

// New endpoint for enhanced AI detection analysis
app.post('/api/analyze-ai-detection', async (req, res) => {
  try {
    const { code, transcript, language, studentName } = req.body;
    
    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    // Create mock interview data for analysis
    const mockInterviewData = {
      transcript: transcript,
      status: 'completed'
    };

    console.log(`🤖 Running Gemini AI detection analysis for ${studentName || 'unknown student'}`);
    const analysis = await analyzeForAIDetection(mockInterviewData, code);
    
    res.json({
      success: true,
      analysis,
      originalCode: code,
      transcript: transcript,
      studentInfo: {
        name: studentName || 'Unknown Student',
        language: language || 'Unknown'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in AI detection analysis:', error);
    res.status(500).json({ 
      error: 'Failed to analyze for AI detection',
      details: error.message 
    });
  }
});

// Debug endpoint to check sessions
app.get('/api/debug/sessions', (req, res) => {
  const sessionData = Array.from(sessions.entries()).map(([key, value]) => ({
    sessionId: key,
    studentName: value.studentName,
    language: value.language,
    createdAt: value.createdAt,
    hasCode: !!value.code
  }));
  
  res.json({
    sessionCount: sessions.size,
    sessions: sessionData
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
