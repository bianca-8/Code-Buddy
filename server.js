const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const RIBBON_API_KEY = process.env.RIBBON_API_KEY;
const RIBBON_BASE_URL = 'https://app.ribbon.ai/be-api/v1';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Store interview sessions (in production, use a database)
const sessions = new Map();

// Helper function to generate code analysis questions
function generateCodeQuestions(code, language) {
  const baseQuestions = [
    "Can you walk me through what this code does, line by line?",
    "What is the main purpose or functionality of this code?",
    "Can you explain any algorithms or data structures used in this code?",
    "How would you modify this code to handle edge cases or errors?",
    "What would happen if you changed this specific part of the code, and why?"
  ];
  
  // Add language-specific questions
  const languageQuestions = {
    javascript: "Can you explain how JavaScript's event loop would handle this code?",
    python: "Can you explain the Python-specific features or libraries used here?",
    java: "Can you explain the object-oriented principles demonstrated in this code?",
    cpp: "Can you explain the memory management aspects of this C++ code?",
    default: "Can you explain any language-specific features used in this code?"
  };
  
  const langQuestion = languageQuestions[language.toLowerCase()] || languageQuestions.default;
  return [...baseQuestions, langQuestion];
}

// Create interview flow for code review
async function createInterviewFlow(code, language, studentName) {
  try {
    const questions = generateCodeQuestions(code, language);
    
    const response = await axios.post(`${RIBBON_BASE_URL}/interview-flows`, {
      org_name: "Code Buddy",
      title: `Code Review Interview - ${language}`,
      questions: questions,
      interview_type: "recruitment",
      is_video_enabled: true
    }, {
      headers: {
        'Authorization': `Bearer ${RIBBON_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    return response.data.interview_flow_id;
  } catch (error) {
    console.error('Error creating interview flow:', error.response?.data || error.message);
    throw error;
  }
}

// Create interview session
async function createInterview(interviewFlowId, studentEmail, studentName) {
  try {
    const [firstName, ...lastNameParts] = studentName.split(' ');
    const lastName = lastNameParts.join(' ') || '';
    
    const response = await axios.post(`${RIBBON_BASE_URL}/interviews`, {
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
    
    const response = await axios.get(`${RIBBON_BASE_URL}/interviews`, {
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

// Analyze interview for AI detection
function analyzeForAIDetection(interviewData, originalCode) {
  if (!interviewData || !interviewData.transcript) {
    return {
      confidence: 0,
      aiLikelihood: 'unknown',
      reasoning: 'No interview data available'
    };
  }
  
  const transcript = interviewData.transcript.toLowerCase();
  
  // Scoring factors
  let score = 50; // Start neutral
  const factors = [];
  
  // Positive indicators (human-written)
  if (transcript.includes('i wrote') || transcript.includes('i coded') || transcript.includes('i implemented')) {
    score += 15;
    factors.push('Claims personal authorship (+15)');
  }
  
  if (transcript.includes('struggled') || transcript.includes('difficult') || transcript.includes('challenging')) {
    score += 10;
    factors.push('Mentions coding challenges (+10)');
  }
  
  if (transcript.includes('debugged') || transcript.includes('fixed bugs') || transcript.includes('error')) {
    score += 12;
    factors.push('Discusses debugging process (+12)');
  }
  
  // Detailed explanations
  const codeKeywords = ['variable', 'function', 'loop', 'condition', 'algorithm', 'data structure'];
  const keywordMatches = codeKeywords.filter(keyword => transcript.includes(keyword)).length;
  if (keywordMatches >= 3) {
    score += 10;
    factors.push(`Uses technical terminology (${keywordMatches} matches) (+10)`);
  }
  
  // Negative indicators (AI-generated)
  if (transcript.includes('generated') || transcript.includes('chatgpt') || transcript.includes('ai')) {
    score -= 25;
    factors.push('Mentions AI tools (-25)');
  }
  
  if (transcript.includes('copy') || transcript.includes('paste') || transcript.includes('copied')) {
    score -= 15;
    factors.push('Mentions copying code (-15)');
  }
  
  if (transcript.includes("don't know") || transcript.includes("not sure") || transcript.includes("can't explain")) {
    score -= 12;
    factors.push('Shows uncertainty about code (-12)');
  }
  
  // Very short or generic responses
  if (transcript.length < 200) {
    score -= 10;
    factors.push('Very brief responses (-10)');
  }
  
  // Ensure score is within bounds
  score = Math.max(0, Math.min(100, score));
  
  let aiLikelihood;
  let confidence;
  
  if (score >= 70) {
    aiLikelihood = 'likely human-written';
    confidence = 'high';
  } else if (score >= 50) {
    aiLikelihood = 'possibly human-written';
    confidence = 'medium';
  } else if (score >= 30) {
    aiLikelihood = 'possibly AI-generated';
    confidence = 'medium';
  } else {
    aiLikelihood = 'likely AI-generated';
    confidence = 'high';
  }
  
  return {
    score,
    confidence,
    aiLikelihood,
    reasoning: factors.join('; '),
    transcriptLength: transcript.length
  };
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
      
      // Analyze without original code
      const analysis = analyzeForAIDetection(interviewData, null);
      
      res.json({
        status: 'completed',
        analysis,
        transcript: interviewData.transcript,
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
    console.log(`🔍 Analyzing completed interview...`);
    const analysis = analyzeForAIDetection(interviewData, session.code);
    console.log(`✅ Analysis complete - Score: ${analysis.score}`);
    
    res.json({
      status: 'completed',
      analysis,
      transcript: interviewData.transcript,
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Make sure to set your RIBBON_API_KEY in the .env file`);
});
