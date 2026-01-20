// Seed mock feedback data for testing
// This script creates sample feedback items with various sentiment and urgency levels

const mockFeedbackItems = [
  {
    text: 'Login has been broken for 3 days, our users are unable to access their accounts!',
    source: 'email',
    sentiment: 'NEGATIVE',
    category: 'Bug',
    urgency: 'critical',
    summary: 'Login authentication broken, blocking all user access'
  },
  {
    text: 'The new dark mode feature is amazing! Makes it so much easier on the eyes.',
    source: 'discord',
    sentiment: 'POSITIVE',
    category: 'Feature Request',
    urgency: 'low',
    summary: 'User loves new dark mode feature'
  },
  {
    text: 'Dashboard loads very slowly, sometimes takes 30+ seconds. Performance is terrible.',
    source: 'github-issue',
    sentiment: 'NEGATIVE',
    category: 'Performance',
    urgency: 'high',
    summary: 'Dashboard performance issue - slow loading'
  },
  {
    text: 'Documentation for the API is outdated and missing examples. Please update it.',
    source: 'twitter',
    sentiment: 'NEGATIVE',
    category: 'Documentation',
    urgency: 'medium',
    summary: 'API documentation needs updates and examples'
  },
  {
    text: 'Great customer support team! They resolved my issue in under 2 hours.',
    source: 'support-ticket',
    sentiment: 'POSITIVE',
    category: 'Other',
    urgency: 'low',
    summary: 'Positive feedback on customer support experience'
  }
];

// This is a TypeScript file showing the structure of mock data
// In production, you would:
// 1. Run: npm run dev
// 2. Use the API: curl -X POST http://localhost:8787/api/feedback -H "Content-Type: application/json" -d '{"text":"Your feedback"}'
// 3. Or import this data programmatically in tests

export { mockFeedbackItems };
