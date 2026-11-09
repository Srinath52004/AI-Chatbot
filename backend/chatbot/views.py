import json
import logging

from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)
MAX_MESSAGES = 40
MAX_MESSAGE_LENGTH = 8000
MAX_HISTORY_LENGTH = 24000


@require_GET
@ensure_csrf_cookie
def csrf_token(request):
    return JsonResponse({'csrfToken': get_token(request)})


@require_POST
def chat(request):
    if not settings.GEMINI_API_KEY:
        return JsonResponse(
            {'error': 'Gemini is not configured. Set GEMINI_API_KEY in backend/.env.'},
            status=503,
        )

    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({'error': 'Send a valid JSON request.'}, status=400)

    messages = payload.get('messages') if isinstance(payload, dict) else None
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        return JsonResponse(
            {'error': f'messages must contain between 1 and {MAX_MESSAGES} items.'},
            status=400,
        )

    normalized_messages = []
    history_length = 0
    for message in messages:
        if not isinstance(message, dict):
            return JsonResponse({'error': 'Each message must have a role and content.'}, status=400)

        role = message.get('role')
        content = message.get('content')
        if role not in ('user', 'assistant') or not isinstance(content, str) or not content.strip():
            return JsonResponse({'error': 'Each message needs a valid role and non-empty content.'}, status=400)
        if len(content) > MAX_MESSAGE_LENGTH:
            return JsonResponse({'error': 'A message is too long.'}, status=400)

        history_length += len(content)
        if history_length > MAX_HISTORY_LENGTH:
            return JsonResponse({'error': 'This conversation is too long. Start a new chat.'}, status=400)
        normalized_messages.append((role, content))

    if normalized_messages[-1][0] != 'user':
        return JsonResponse({'error': 'The latest message must be from the user.'}, status=400)

    history = [
        {
            'type': 'user_input' if role == 'user' else 'model_output',
            'content': [{'type': 'text', 'text': content}],
        }
        for role, content in normalized_messages
    ]

    try:
        client = genai.Client(
            api_key=settings.GEMINI_API_KEY,
            http_options=types.HttpOptions(timeout=180_000),
        )
        events = client.interactions.create(
            model=settings.GEMINI_MODEL,
            input=history,
            store=False,
            system_instruction=settings.GEMINI_SYSTEM_INSTRUCTION,
            stream=True,
        )
    except Exception:
        logger.exception('Gemini chat request failed')
        return JsonResponse(
            {
                'error': (
                    'Gemini could not complete the request. Check the Django terminal '
                    'for details, then verify your API key and configured model.'
                ),
            },
            status=502,
        )

    def stream_reply(client=client):
        try:
            has_text = False
            for event in events:
                if event.event_type == 'step.delta' and getattr(event.delta, 'type', None) == 'text':
                    text = event.delta.text
                    if text:
                        has_text = True
                        yield json.dumps({'text': text}) + '\n'

            if has_text:
                yield json.dumps({'done': True}) + '\n'
            else:
                yield json.dumps({'error': 'Gemini returned an empty response. Please try again.'}) + '\n'
        except Exception:
            logger.exception('Gemini chat stream failed')
            yield json.dumps(
                {'error': 'Gemini could not complete the request. Please try again.'}
            ) + '\n'
        finally:
            client.close()

    response = StreamingHttpResponse(stream_reply(), content_type='application/x-ndjson')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response
