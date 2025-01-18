export default {
    async fetch(request, env) {
      // 处理 OPTIONS 请求
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*'
          }
        });
      }
  
      try {
        const url = new URL(request.url);
        const targetUrl = env.QWEN_BASE_URL + url.pathname + url.search;
  
        // 创建新的请求头，保留原始认证信息
        const headers = new Headers({
          'Authorization': request.headers.get('Authorization') || '',
        });
  
        // 如果是 POST 请求，添加 Content-Type
        if (request.method === 'POST') {
          headers.set('Content-Type', 'application/json');
        }
  
        // 处理图片上传
        if (url.pathname === '/api/chat/completions' && request.method === 'POST') {
          const body = await request.json();
          
          if (Array.isArray(body?.messages)) {
            const convertedMessages = await Promise.all(body.messages.map(async message => {
              if (Array.isArray(message.content)) {
                const convertedContent = await Promise.all(message.content.map(async content => {
                  if (content.type === 'image_url' && content.image_url?.url?.startsWith('data:image')) {
                    // 上传图片到API
                    const base64Data = content.image_url.url.split(',')[1] || content.image_url.url;
                    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
                    
                    const formData = new FormData();
                    formData.append('file', new Blob([binaryData]), 'image.png');
                    
                    const uploadResponse = await fetch(`${env.QWEN_BASE_URL}/api/v1/files/`, {
                      method: 'POST',
                      headers: {
                        'Authorization': request.headers.get('Authorization') || ''
                      },
                      body: formData
                    });
  
                    if (!uploadResponse.ok) {
                      throw new Error(`Failed to upload image: ${uploadResponse.statusText}`);
                    }
  
                    const result = await uploadResponse.json();
                    // 转换为 QwenLM API 支持的格式
                    return {
                      type: 'image',
                      image: result.id
                    };
                  }
                  return content;
                }));
                return { ...message, content: convertedContent };
              }
              return message;
            }));
  
            body.messages = convertedMessages;
          }
  
          // 发送修改后的请求
          const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          });
  
          // 处理流式响应
          if (body.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
            let buffer = '';
            let previousContent = '';
            
            const transformStream = new TransformStream({
              async transform(chunk, controller) {
                const text = new TextDecoder().decode(chunk);
                buffer += text;
                
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                  if (!line.trim() || !line.startsWith('data: ')) continue;
                  
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                    continue;
                  }
  
                  try {
                    const parsed = JSON.parse(data);
                    const choice = parsed.choices?.[0];
  
                    if (choice?.delta?.content) {
                      const currentContent = choice.delta.content;
                      
                      // 修改后的增量内容计算逻辑
                      let incrementalContent = currentContent;
                      if (previousContent && currentContent.startsWith(previousContent)) {
                        incrementalContent = currentContent.slice(previousContent.length);
                      }
                      
                      if (incrementalContent) {
                        const newOutput = {
                          ...parsed,
                          choices: [{
                            ...choice,
                            delta: { content: incrementalContent }
                          }]
                        };
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(newOutput)}\n\n`));
                      }
                      previousContent = currentContent;
                    } else if (choice?.delta?.role) {
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(parsed)}\n\n`));
                    }
                  } catch (e) {
                    console.error('Failed to parse JSON:', e);
                  }
                }
              }
            });
  
            return new Response(response.body.pipeThrough(transformStream), {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
  
          return new Response(response.body, {
            status: response.status,
            headers: {
              'Content-Type': response.headers.get('Content-Type') || 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
  
        // 处理其他请求
        const response = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: request.method !== 'GET' ? await request.text() : null
        });
  
        return new Response(response.body, {
          status: response.status,
          headers: {
            'Content-Type': response.headers.get('Content-Type') || 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Proxy error:', error);
        return new Response(JSON.stringify({
          error: 'proxy_error',
          message: error.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
  }
  