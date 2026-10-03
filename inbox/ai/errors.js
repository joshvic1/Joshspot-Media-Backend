// Only fixed, safe messages reach logs; never serialize Axios errors or headers.
const messages={
 AI_DAILY_LIMIT:'Daily AI request limit reached. Review AI Settings or wait for the UTC daily reset.',
 AI_CONVERSATION_LIMIT:'This conversation reached its daily AI request limit. Review AI Settings or wait for the UTC daily reset.',
 AI_NOT_CONFIGURED:'The backend needs an OpenAI API key and model setting.',
 AI_AUTH_FAILED:'OpenAI rejected the backend API key. Check the deployed key and project permissions.',
 AI_QUOTA_EXHAUSTED:'OpenAI API quota is exhausted. Check API billing and project limits.',
 AI_RATE_LIMIT:'OpenAI rate-limited this request. Try again later.',
 AI_TIMEOUT:'OpenAI did not respond before the request timeout.',
 AI_MODEL_UNAVAILABLE:'The configured OpenAI model is unavailable to this project.',
 AI_REQUEST_REJECTED:'OpenAI rejected the request configuration. Check the model and structured-output support.',
 AI_PROVIDER_ERROR:'OpenAI is unavailable or returned an invalid response.',
 AI_KNOWLEDGE_INDEX:'Knowledge search failed because its database text index is missing.',
 AI_PROCESSING_ERROR:'AI processing failed. Check backend database connectivity and approved response variables.',
};
function describe(error){
 const code=messages[error?.code]?error.code:error?.code===27?'AI_KNOWLEDGE_INDEX':'AI_PROCESSING_ERROR';
 return {code,message:messages[code]};
}
function providerError(error){
 const status=error.response?.status;const remote=error.response?.data?.error?.code;
 const code=remote==='insufficient_quota'?'AI_QUOTA_EXHAUSTED':status===401||status===403?'AI_AUTH_FAILED':status===429?'AI_RATE_LIMIT':['ECONNABORTED','ETIMEDOUT'].includes(error.code)?'AI_TIMEOUT':status===404?'AI_MODEL_UNAVAILABLE':status===400?'AI_REQUEST_REJECTED':'AI_PROVIDER_ERROR';
 return Object.assign(new Error(messages[code]),{code});
}
module.exports={describe,providerError};
