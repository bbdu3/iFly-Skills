"""One request per process. Only package-owned operations may load skill code."""

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

BRIDGE_ROOT = Path(__file__).resolve().parent
RUNTIME_ROOT = BRIDGE_ROOT.parent
MAX_REQUEST_BYTES = 1024 * 1024


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code


class DiscardDiagnostics:
    """Do not retain or forward arbitrary upstream prints or exception details."""
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def load_packaged_module(relative_path):
    target = RUNTIME_ROOT
    for part in relative_path.split('/'):
        if part in ('', '.', '..'):
            raise BridgeError('RUNTIME_MISSING')
        target = target / part
        if target.is_symlink():
            raise BridgeError('RUNTIME_MISSING')
    if not target.is_file() or not target.resolve().is_relative_to(RUNTIME_ROOT):
        raise BridgeError('RUNTIME_MISSING')
    spec = importlib.util.spec_from_file_location('ifly_packaged_skill', target)
    module = importlib.util.module_from_spec(spec)
    # Legacy modules may sys.exit when imports fail. Classify import-time exits
    # separately, without parsing the human-readable diagnostic text.
    try:
        spec.loader.exec_module(module)
    except (ImportError, SystemExit) as error:
        raise BridgeError('DEPENDENCY_MISSING') from error
    return module


def list_voices(request):
    """Read bundled voice constants; does not authenticate or synthesize speech."""
    if set(request['input']) - {'files'} or request['input'].get('files') or request['parameters']:
        raise BridgeError('INVALID_INPUT')
    skill = load_packaged_module('skills/iflytek-hyper-tts/scripts/xfei_hyper_tts.py')
    return {'defaultVoice': skill.DEFAULT_VOICE, 'freeVoices': skill.FREE_VOICES, 'voices': skill.VOICE_LIST}, []


def _parameters(request):
    parameters = request['parameters']
    if not isinstance(parameters, dict):
        raise BridgeError('INVALID_INPUT')
    return parameters


def _text(request):
    value = request['input'].get('text')
    if isinstance(value, str):
        text = value
    elif value is None and isinstance(request['input'].get('files'), dict):
        relative = request['input']['files'].get('text')
        text = _read_file(relative, encoding='utf-8')
    else:
        raise BridgeError('INVALID_INPUT')
    if not text.strip() or len(text.encode('utf-8')) > 1024 * 1024:
        raise BridgeError('INVALID_INPUT')
    return text


def _read_file(relative, encoding=None):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise BridgeError('INVALID_INPUT')
    root = Path(os.environ.get('TMP', '')).resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise BridgeError('INVALID_INPUT')
    if not target.is_file() or target.is_symlink():
        raise BridgeError('INVALID_INPUT')
    try:
        data = target.read_bytes()
        return data.decode(encoding) if encoding else data
    except (OSError, UnicodeError):
        raise BridgeError('INVALID_INPUT')


def translate(request):
    skill = load_packaged_module('skills/iflytek-translate/scripts/translate.py')
    text = _text(request)
    parameters = _parameters(request)
    from_lang_value = parameters.get('fromLanguage', 'cn')
    to_lang_value = parameters.get('toLanguage', 'en')
    if not isinstance(from_lang_value, str) or not isinstance(to_lang_value, str):
        raise BridgeError('INVALID_INPUT')
    from_lang = skill._normalize_lang(from_lang_value)
    to_lang = skill._normalize_lang(to_lang_value)
    if not from_lang or not to_lang:
        raise BridgeError('INVALID_INPUT')
    try:
        body = skill._build_body(os.environ['IFLY_APP_ID'], text, from_lang, to_lang)
        response = skill._http_post(skill.URL, body, skill._build_headers(
            os.environ['IFLY_API_KEY'], os.environ['IFLY_API_SECRET'], body))
        parsed, error = skill._parse_result(response)
    except BridgeError:
        raise
    except Exception as error:
        raise BridgeError('UPSTREAM_ERROR') from error
    if parsed is None or error:
        raise BridgeError('UPSTREAM_ERROR')
    return {'sourceText': parsed.get('src', ''), 'translatedText': parsed.get('dst', ''),
            'sourceLanguage': parsed.get('from', from_lang), 'targetLanguage': parsed.get('to', to_lang)}, []


def proofread(request):
    skill = load_packaged_module('skills/iflytek-text-proofread/scripts/text_proofread.py')
    text = _text(request)
    try:
        auth_url = skill._build_auth_url(skill.API_URL, os.environ['IFLY_API_KEY'], os.environ['IFLY_API_SECRET'])
        response = skill._http_post(auth_url, skill._build_body(os.environ['IFLY_APP_ID'], text), os.environ['IFLY_APP_ID'])
        result = skill._parse_result(response)
    except Exception as error:
        raise BridgeError('UPSTREAM_ERROR') from error
    if not isinstance(result, dict) or result.get('error'):
        raise BridgeError('UPSTREAM_ERROR')
    return {'result': result}, []


def recognize_invoice(request):
    skill = load_packaged_module('skills/iflytek-ocr-invoice/scripts/invoice.py')
    files = request['input'].get('files')
    if not isinstance(files, dict) or 'image' not in files:
        raise BridgeError('INVALID_INPUT')
    path = _invoice_input_path(files['image'])
    try:
        raw = skill.recognize_invoice(path, os.environ['IFLY_APP_ID'], os.environ['IFLY_API_KEY'], os.environ['IFLY_API_SECRET'])
        extracted = skill.extract_result(raw)
        try:
            result = json.loads(extracted)
        except (TypeError, json.JSONDecodeError):
            result = extracted
    except BridgeError:
        raise
    except Exception as error:
        raise BridgeError('UPSTREAM_ERROR') from error
    if isinstance(result, str) and result.startswith(('API Error', 'Unexpected response')):
        raise BridgeError('UPSTREAM_ERROR')
    return {'result': result}, []


def _file_path(relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise BridgeError('INVALID_INPUT')
    root = Path(os.environ.get('TMP', '')).resolve()
    target = (root / relative).resolve()
    if ((target != root and root not in target.parents) or not target.is_file() or target.is_symlink()):
        raise BridgeError('INVALID_INPUT')
    return str(target)


def _invoice_input_path(relative):
    source = Path(_file_path(relative))
    try:
        header = source.read_bytes()[:16]
    except OSError:
        raise BridgeError('INVALID_INPUT')
    if header.startswith(b'%PDF'):
        suffix = '.pdf'
    elif header.startswith(b'\x89PNG\r\n\x1a\n'):
        suffix = '.png'
    elif header.startswith(b'\xff\xd8\xff'):
        suffix = '.jpg'
    elif header.startswith((b'GIF87a', b'GIF89a')):
        suffix = '.gif'
    elif header.startswith(b'BM'):
        suffix = '.bmp'
    elif header[:4] in (b'II*\x00', b'MM\x00*'):
        suffix = '.tif'
    else:
        suffix = '.jpg'
    target = source.parent / ('invoice-input' + suffix)
    try:
        shutil.copyfile(source, target)
    except OSError:
        raise BridgeError('INVALID_INPUT')
    return str(target)


def synthesize(request):
    skill = load_packaged_module('skills/iflytek-hyper-tts/scripts/xfei_hyper_tts.py')
    text = _text(request)
    parameters = _parameters(request)
    voice = parameters.get('voice', skill.DEFAULT_VOICE)
    speed = parameters.get('speed', 50)
    volume = parameters.get('volume', 50)
    pitch = parameters.get('pitch', 50)
    sample_rate = parameters.get('sampleRate', 24000)
    role = parameters.get('role')
    if not isinstance(voice, str) or not voice or any(type(value) is not int or value < 0 or value > 100
                                                       for value in (speed, volume, pitch)):
        raise BridgeError('INVALID_INPUT')
    if type(sample_rate) is not int or sample_rate not in (8000, 16000, 24000) or role is not None and not isinstance(role, str):
        raise BridgeError('INVALID_INPUT')
    output = Path(os.environ.get('TMP', '')) / 'speech.mp3'
    try:
        client = skill.XfeiHyperTTSClient(os.environ['IFLY_APP_ID'], os.environ['IFLY_API_KEY'], os.environ['IFLY_API_SECRET'])
        result = client.synthesize(text=text, output_path=str(output), vcn=voice, speed=speed, volume=volume,
                                   pitch=pitch, encoding='lame', sample_rate=sample_rate, role=role)
    except Exception as error:
        raise BridgeError('UPSTREAM_ERROR') from error
    if not output.is_file() or output.is_symlink():
        raise BridgeError('INVALID_ARTIFACT')
    return result, [{'relativePath': 'speech.mp3', 'fileName': 'speech.mp3', 'mimeType': 'audio/mpeg'}]


# Fixed dispatch table for packaged adapters; test adapters are excluded.
OPERATIONS = {
    ('iflytek-translate', 'translate'): translate,
    ('iflytek-text-proofread', 'check'): proofread,
    ('iflytek-ocr-invoice', 'recognize'): recognize_invoice,
    ('iflytek-hyper-tts', 'synthesize'): synthesize,
    ('iflytek-hyper-tts', 'listVoices'): list_voices,
}


def reject_constant(_value):
    raise BridgeError('INVALID_INPUT')


def main():
    started = time.monotonic()
    request_id = ''
    try:
        if len(sys.argv) != 5 or sys.argv[1] != '--skill' or sys.argv[3] != '--operation':
            raise BridgeError('INVALID_INPUT')
        payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(payload) > MAX_REQUEST_BYTES:
            raise BridgeError('INVALID_INPUT')
        request = json.loads(payload.decode('utf-8'), parse_constant=reject_constant)
        if not isinstance(request, dict) or request.get('protocolVersion') != 1:
            raise BridgeError('INVALID_INPUT')
        request_id = request.get('requestId', '')
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            request_id = ''
            raise BridgeError('INVALID_INPUT')
        if set(request) != {'protocolVersion', 'requestId', 'input', 'parameters'}:
            raise BridgeError('INVALID_INPUT')
        if not isinstance(request['input'], dict) or not isinstance(request['parameters'], dict):
            raise BridgeError('INVALID_INPUT')
        key = (sys.argv[2], sys.argv[4])
        manifest = json.loads((BRIDGE_ROOT / 'operations.json').read_text(encoding='utf-8'))
        entry = next((entry for entry in manifest['operations']
                      if (entry['skill'], entry['operation']) == key), None)
        if manifest['protocolVersion'] != 1 or entry is None or key not in OPERATIONS:
            raise BridgeError('UNSUPPORTED_OPERATION')
        fields = {'appId': 'IFLY_APP_ID', 'apiKey': 'IFLY_API_KEY', 'apiSecret': 'IFLY_API_SECRET'}
        if any(not os.environ.get(fields[field], '').strip() for field in entry['credentials']):
            raise BridgeError('AUTH_FAILED')
        with contextlib.redirect_stdout(DiscardDiagnostics()), contextlib.redirect_stderr(DiscardDiagnostics()):
            data, artifacts = OPERATIONS[key](request)
        response = {'protocolVersion': 1, 'requestId': request_id, 'ok': True,
                    'status': 'succeeded', 'data': data, 'artifacts': artifacts,
                    'meta': {'durationMs': round((time.monotonic() - started) * 1000)}}
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            code = 'EXECUTION_CANCELLED'
        elif isinstance(error, BridgeError):
            code = error.code
        elif isinstance(error, ImportError):
            code = 'DEPENDENCY_MISSING'
        elif isinstance(error, (ValueError, UnicodeError)):
            code = 'INVALID_INPUT'
        else:
            code = 'PROCESS_EXIT'
        response = {'protocolVersion': 1, 'requestId': request_id, 'ok': False,
                    'error': {'code': code, 'message': code, 'retryable': False}}
        encoded = json.dumps(response, ensure_ascii=False)
        sys.stdout.write(encoded + '\n')
        return 1
    sys.stdout.write(encoded + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
