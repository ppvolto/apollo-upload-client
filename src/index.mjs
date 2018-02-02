import { ApolloLink, Observable } from 'apollo-link'
import { print } from 'graphql/language/printer'
import extractFiles from 'extract-files'

export { ReactNativeFile } from 'extract-files'
const throwServerError = (response, result, message) => {
  const error = new Error(message)

  error.response = response
  error.statusCode = response.status
  error.result = result

  throw error
}

const parseAndCheckResponse = request => response => {
  return response
    .text()
    .then(bodyText => {
      try {
        return JSON.parse(bodyText)
      } catch (err) {
        const parseError = err
        parseError.response = response
        parseError.statusCode = response.status
        parseError.bodyText = bodyText
        return Promise.reject(parseError)
      }
    })
    .then(result => {
      if (response.status >= 300)
        //Network error
        throwServerError(
          response,
          result,
          `Response not successful: Received status code ${response.status}`
        )

      if (!result.hasOwnProperty('data') && !result.hasOwnProperty('errors'))
        //Data error
        throwServerError(
          response,
          result,
          `Server response was missing for query '${request.operationName}'.`
        )

      return result
    })
}
const warnIfNoFetch = fetcher => {
  if (!fetcher && typeof fetch === 'undefined') {
    let library = 'unfetch'
    if (typeof window === 'undefined') library = 'node-fetch'
    throw new Error(
      `fetch is not found globally and no fetcher passed, to fix pass a fetch for
      your environment like https://www.npmjs.com/package/${library}.
      For example:
        import fetch from '${library}';
        import { createUploadLink } from 'apollo-link-http';
        const link = createUploadLink({ uri: '/graphql', fetch: fetch });
      `
    )
  }
}

const createSignalIfSupported = () => {
  if (typeof AbortController === 'undefined')
    return { controller: false, signal: false }

  const controller = new AbortController()
  const signal = controller.signal
  return { controller, signal }
}

const defaultHttpOptions = {
  includeQuery: true,
  includeExtensions: false
}

export const createUploadLink = (linkOptions = {}) => {
  let {
    uri,
    fetch: fetcher,
    includeExtensions,
    ...requestOptions
  } = linkOptions
  // dev warnings to ensure fetch is present
  warnIfNoFetch(fetcher)

  // use default global fetch is nothing passed in
  if (!fetcher) fetcher = fetch
  if (!uri) uri = '/graphql'

  return new ApolloLink(
    operation =>
      new Observable(observer => {
        const {
          headers,
          credentials,
          fetchOptions = {},
          uri: contextURI,
          http: httpOptions = {}
        } = operation.getContext()
        const { operationName, extensions, variables, query } = operation
        const http = { ...defaultHttpOptions, ...httpOptions }

        const printedQuery = print(query)
        const body = new FormData()

        const files = extractFiles(variables)
        if (files.length)
          files.forEach(({ file }) => body.append('file', file, file.name))

        body.append('operationName', operationName)
        try {
          body.append('variables', JSON.stringify(variables))
        } catch (e) {
          const parseError = new Error(
            `Network request failed. Payload is not serializable: ${e.message}`
          )
          parseError.parseError = e
          throw parseError
        }

        if (includeExtensions || http.includeExtensions)
          body.append('extensions', extensions)

        // not sending the query (i.e persisted queries)
        if (http.includeQuery) body.append('query', printedQuery)

        let options = fetchOptions
        if (requestOptions.fetchOptions)
          options = { ...requestOptions.fetchOptions, ...options }
        const fetcherOptions = {
          method: 'POST',
          ...options,
          headers: {
            // headers are case insensitive (https://stackoverflow.com/a/5259004)
            accept: '*/*'
          },
          body: body
        }

        if (requestOptions.credentials)
          fetcherOptions.credentials = requestOptions.credentials
        if (credentials) fetcherOptions.credentials = credentials

        if (requestOptions.headers)
          fetcherOptions.headers = {
            ...fetcherOptions.headers,
            ...requestOptions.headers
          }
        if (headers)
          fetcherOptions.headers = { ...fetcherOptions.headers, ...headers }

        const { controller, signal } = createSignalIfSupported()
        if (controller) fetcherOptions.signal = signal

        fetcher(contextURI || uri, fetcherOptions)
          // attach the raw response to the context for usage
          .then(response => {
            operation.setContext({ response })
            return response
          })
          .then(parseAndCheckResponse(operation))
          .then(result => {
            // we have data and can send it to back up the link chain
            observer.next(result)
            observer.complete()
            return result
          })
          .catch(err => {
            // fetch was cancelled so its already been cleaned up in the unsubscribe
            if (err.name === 'AbortError') return
            observer.error(err)
          })

        return () => {
          // XXX support canceling this request
          // https://developers.google.com/web/updates/2017/09/abortable-fetch
          if (controller) controller.abort()
        }
      })
  )
}
