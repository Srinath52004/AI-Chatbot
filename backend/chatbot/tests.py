import json
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase, override_settings


class ChatEndpointTests(TestCase):
    def test_csrf_endpoint_returns_token_and_sets_cookie(self):
        response = self.client.get('/api/csrf/')

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['csrfToken'])
        self.assertIn('csrftoken', response.cookies)

    @override_settings(GEMINI_API_KEY='test-key')
    @patch('chatbot.views.genai.Client')
    def test_chat_sends_history_to_gemini_and_returns_reply(self, client_factory):
        gemini_client = client_factory.return_value
        gemini_client.interactions.create.return_value = iter([
            SimpleNamespace(
                event_type='step.delta',
                delta=SimpleNamespace(type='text', text='Hello'),
            ),
            SimpleNamespace(
                event_type='step.delta',
                delta=SimpleNamespace(type='text', text=' from Gemini'),
            ),
            SimpleNamespace(event_type='interaction.completed'),
        ])
        messages = [
            {'role': 'user', 'content': 'Hello'},
            {'role': 'assistant', 'content': 'Hi there'},
            {'role': 'user', 'content': 'What can you do?'},
        ]

        response = self.client.post(
            '/api/chat/',
            data=json.dumps({'messages': messages}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'application/x-ndjson')
        self.assertEqual(
            b''.join(response.streaming_content).decode(),
            '{"text": "Hello"}\n{"text": " from Gemini"}\n{"done": true}\n',
        )
        gemini_client.close.assert_called_once_with()
        self.assertEqual(client_factory.call_args.kwargs['api_key'], 'test-key')
        self.assertEqual(client_factory.call_args.kwargs['http_options'].timeout, 180_000)
        request = gemini_client.interactions.create.call_args.kwargs
        self.assertEqual(request['model'], 'gemini-3.5-flash-lite')
        self.assertFalse(request['store'])
        self.assertTrue(request['stream'])
        self.assertNotIn('generation_config', request)
        self.assertEqual(
            request['input'],
            [
                {'type': 'user_input', 'content': [{'type': 'text', 'text': 'Hello'}]},
                {'type': 'model_output', 'content': [{'type': 'text', 'text': 'Hi there'}]},
                {'type': 'user_input', 'content': [{'type': 'text', 'text': 'What can you do?'}]},
            ],
        )

    @override_settings(GEMINI_API_KEY='')
    def test_chat_reports_missing_api_key(self):
        response = self.client.post(
            '/api/chat/',
            data=json.dumps({'messages': [{'role': 'user', 'content': 'Hello'}]}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn('GEMINI_API_KEY', response.json()['error'])

    @override_settings(GEMINI_API_KEY='test-key')
    def test_chat_rejects_invalid_history(self):
        response = self.client.post(
            '/api/chat/',
            data=json.dumps({'messages': [{'role': 'assistant', 'content': 'Not a user turn'}]}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('latest message', response.json()['error'])
