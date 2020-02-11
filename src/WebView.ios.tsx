import React from 'react';
import {
  UIManager as NotTypedUIManager,
  View,
  requireNativeComponent,
  NativeModules,
  Image,
  findNodeHandle,
  ImageSourcePropType,
} from 'react-native';
import invariant from 'invariant';

import {
  defaultOriginWhitelist,
  createOnShouldStartLoadWithRequest,
  defaultRenderError,
  defaultRenderLoading,
} from './WebViewShared';
import {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigationEvent,
  WebViewProgressEvent,
  WebViewTerminatedEvent,
  IOSWebViewProps,
  DecelerationRateConstant,
  NativeWebViewIOS,
  ViewManager,
  State,
  RNCWebViewUIManagerIOS,
} from './WebViewTypes';

import styles from './WebView.styles';

const UIManager = NotTypedUIManager as RNCWebViewUIManagerIOS;

const { resolveAssetSource } = Image;
const processDecelerationRate = (
  decelerationRate: DecelerationRateConstant | number | undefined,
) => {
  let newDecelerationRate = decelerationRate;
  if (newDecelerationRate === 'normal') {
    newDecelerationRate = 0.998;
  } else if (newDecelerationRate === 'fast') {
    newDecelerationRate = 0.99;
  }
  return newDecelerationRate;
};

const RNCWebViewManager = NativeModules.RNCWebViewManager as ViewManager;

const RNCWebView: typeof NativeWebViewIOS = requireNativeComponent(
  'RNCWebView',
);

export type AdornedRef = NativeWebViewIOS & WebView;

/**
 * TODO: make these typings suit Android as well.
 */
interface SetAndForwardRefArgs {
  getForwardedRef: () => React.Ref<AdornedRef> | undefined,
  setLocalRef: (ref: AdornedRef) => unknown,
}

/**
 * This is a helper function for when a component needs to be able to forward a ref
 * to a child component, but still needs to have access to that component as part of
 * its implementation.
 *
 * Its main use case is in wrappers for native components.
 *
 * Usage:
 *
 *   class MyView extends React.Component {
 *     _nativeRef = null;
 *
 *     _setNativeRef = setAndForwardRef({
 *       getForwardedRef: () => this.props.forwardedRef,
 *       setLocalRef: ref => {
 *         this._nativeRef = ref;
 *       },
 *     });
 *
 *     render() {
 *       return <View ref={this._setNativeRef} />;
 *     }
 *   }
 *
 *   const MyViewWithRef = React.forwardRef((props, ref) => (
 *     <MyView {...props} forwardedRef={ref} />
 *   ));
 *
 *   module.exports = MyViewWithRef;
 * 
 * @see https://github.com/facebook/react-native/blob/6449cc436365e86fc08d52e0236b0d8f783fcec6/Libraries/Utilities/setAndForwardRef.js#L51
 * @see https://github.com/react-native-community/react-native-webview/pull/1102#issuecomment-571427801
 * 
 * WARNING: I cannot guarantee the correctness of these typings, as I have done my best to convert from Flow and my head hurts.
 */
function setAndForwardRef({
  getForwardedRef,
  setLocalRef,
}: SetAndForwardRefArgs): (ref: AdornedRef) => void {
  return function forwardRef(ref: AdornedRef) {
    const forwardedRef = getForwardedRef();

    setLocalRef(ref);

    // Forward to user ref prop (if one has been specified)
    if (typeof forwardedRef === 'function') {
      // Handle function-based refs. String-based refs are handled as functions.
      forwardedRef(ref);
    } else if (typeof forwardedRef === 'object' && forwardedRef != null) {
      type CreateRefBasedRef = React.MutableRefObject<AdornedRef>;
      // Handle createRef-based refs
      (forwardedRef as CreateRefBasedRef).current = ref!;
    }
  };
}

class WebView extends React.Component<IOSWebViewProps, State> {
  static defaultProps = {
    javaScriptEnabled: true,
    cacheEnabled: true,
    originWhitelist: defaultOriginWhitelist,
    useSharedProcessPool: true,
  };

  static isFileUploadSupported = async () => {
    // no native implementation for iOS, depends only on permissions
    return true;
  };

  state: State = {
    viewState: this.props.startInLoadingState ? 'LOADING' : 'IDLE',
    lastErrorEvent: null,
  };

  _nativeRef: AdornedRef|null = null;

  /** 
   * Required to allow createAnimatedComponent() to hook up to the underlying NativeWebView rather than its wrapping View.
   * @see: Discussion: https://twitter.com/LinguaBrowse/status/1211375582073761799?s=20
   * @see: Implementation: https://github.com/facebook/react-native/blob/8ddf231306e3bd85be718940d04f11d23b570a62/Libraries/Lists/VirtualizedList.js#L515-L521
   */
  getScrollableNode = () => {
    return this._nativeRef;
  };

  _setNativeRef = setAndForwardRef({
    getForwardedRef: () => this.props.forwardedRef,
    setLocalRef: ref => {
      this._nativeRef = ref;

      if(ref){
        ref.getCommands = this.getCommands;
        ref.getScrollableNode = this.getScrollableNode;
        ref.getWebViewHandle = this.getWebViewHandle;
        ref.goBack = this.goBack;
        ref.goForward = this.goForward;
        ref.injectJavaScript = this.injectJavaScript;
        ref.postMessage = this.postMessage;
        ref.reload = this.reload;
        ref.requestFocus = this.requestFocus;
        ref.stopLoading = this.stopLoading;
        ref.updateNavigationState = this.updateNavigationState;
      }
    },
  });

  // eslint-disable-next-line react/sort-comp
  getCommands = () => UIManager.getViewManagerConfig('RNCWebView').Commands;

  /**
   * Go forward one page in the web view's history.
   */
  goForward = () => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().goForward,
      undefined,
    );
  };

  /**
   * Go back one page in the web view's history.
   */
  goBack = () => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().goBack,
      undefined,
    );
  };

  /**
   * Reloads the current page.
   */
  reload = () => {
    this.setState({ viewState: 'LOADING' });
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().reload,
      undefined,
    );
  };

  /**
   * Stop loading the current page.
   */
  stopLoading = () => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().stopLoading,
      undefined,
    );
  };

  /**
   * Request focus on WebView rendered page.
   */
  requestFocus = () => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().requestFocus,
      undefined,
    );
  };

  /**
   * Posts a message to the web view, which will emit a `message` event.
   * Accepts one argument, `data`, which must be a string.
   *
   * In your webview, you'll need to something like the following.
   *
   * ```js
   * document.addEventListener('message', e => { document.title = e.data; });
   * ```
   */
  postMessage = (data: string) => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().postMessage,
      [String(data)],
    );
  };

  /**
   * Injects a javascript string into the referenced WebView. Deliberately does not
   * return a response because using eval() to return a response breaks this method
   * on pages with a Content Security Policy that disallows eval(). If you need that
   * functionality, look into postMessage/onMessage.
   */
  injectJavaScript = (data: string) => {
    UIManager.dispatchViewManagerCommand(
      this.getWebViewHandle(),
      this.getCommands().injectJavaScript,
      [data],
    );
  };

  /**
   * We return an event with a bunch of fields including:
   *  url, title, loading, canGoBack, canGoForward
   */
  updateNavigationState = (event: WebViewNavigationEvent) => {
    if (this.props.onNavigationStateChange) {
      this.props.onNavigationStateChange(event.nativeEvent);
    }
  };

  /**
   * Returns the native `WebView` node.
   */
  getWebViewHandle = () => {
    const nodeHandle = findNodeHandle(this._nativeRef);
    invariant(nodeHandle != null, 'nodeHandle expected to be non-null');
    return nodeHandle as number;
  };

  onLoadingStart = (event: WebViewNavigationEvent) => {
    const { onLoadStart } = this.props;
    if (onLoadStart) {
      onLoadStart(event);
    }
    this.updateNavigationState(event);
  };

  onLoadingError = (event: WebViewErrorEvent) => {
    event.persist(); // persist this event because we need to store it
    const { onError, onLoadEnd } = this.props;
    if (onLoadEnd) {
      onLoadEnd(event);
    }
    if (onError) {
      onError(event);
    }
    console.warn('Encountered an error loading page', event.nativeEvent);

    this.setState({
      lastErrorEvent: event.nativeEvent,
      viewState: 'ERROR',
    });
  };

  onHttpError = (event: WebViewHttpErrorEvent) => {
    const { onHttpError } = this.props;
    if (onHttpError) {
      onHttpError(event);
    }
  }

  onLoadingFinish = (event: WebViewNavigationEvent) => {
    const { onLoad, onLoadEnd } = this.props;
    if (onLoad) {
      onLoad(event);
    }
    if (onLoadEnd) {
      onLoadEnd(event);
    }
    this.setState({
      viewState: 'IDLE',
    });
    this.updateNavigationState(event);
  };

  onMessage = (event: WebViewMessageEvent) => {
    const { onMessage } = this.props;
    if (onMessage) {
      onMessage(event);
    }
  };

  onLoadingProgress = (event: WebViewProgressEvent) => {
    const { onLoadProgress } = this.props;
    if (onLoadProgress) {
      onLoadProgress(event);
    }
  };

  onShouldStartLoadWithRequestCallback = (
    shouldStart: boolean,
    _url: string,
    lockIdentifier: number,
  ) => {
    const viewManager
      = (this.props.nativeConfig && this.props.nativeConfig.viewManager)
      || RNCWebViewManager;

    viewManager.startLoadWithResult(!!shouldStart, lockIdentifier);
  };

  onContentProcessDidTerminate = (event: WebViewTerminatedEvent) => {
    const { onContentProcessDidTerminate } = this.props;
    if (onContentProcessDidTerminate) {
      onContentProcessDidTerminate(event);
    }
  };

  componentDidUpdate(prevProps: IOSWebViewProps) {
    this.showRedboxOnPropChanges(prevProps, 'allowsInlineMediaPlayback');
    this.showRedboxOnPropChanges(prevProps, 'incognito');
    this.showRedboxOnPropChanges(prevProps, 'mediaPlaybackRequiresUserAction');
    this.showRedboxOnPropChanges(prevProps, 'dataDetectorTypes');
  }

  showRedboxOnPropChanges(
    prevProps: IOSWebViewProps,
    propName: keyof IOSWebViewProps,
  ) {
    if (this.props[propName] !== prevProps[propName]) {
      console.error(
        `Changes to property ${propName} do nothing after the initial render.`,
      );
    }
  }

  render() {
    const {
      decelerationRate: decelerationRateProp,
      nativeConfig = {},
      onMessage,
      onShouldStartLoadWithRequest: onShouldStartLoadWithRequestProp,
      originWhitelist,
      renderError,
      renderLoading,
      style,
      containerStyle,
      ...otherProps
    } = this.props;

    let otherView = null;

    if (this.state.viewState === 'LOADING') {
      otherView = (renderLoading || defaultRenderLoading)();
    } else if (this.state.viewState === 'ERROR') {
      const errorEvent = this.state.lastErrorEvent;
      invariant(errorEvent != null, 'lastErrorEvent expected to be non-null');
      otherView = (renderError || defaultRenderError)(
        errorEvent.domain,
        errorEvent.code,
        errorEvent.description,
      );
    } else if (this.state.viewState !== 'IDLE') {
      console.error(
        `RNCWebView invalid state encountered: ${this.state.viewState}`,
      );
    }

    const webViewStyles = [styles.container, styles.webView, style];
    const webViewContainerStyle = [styles.container, containerStyle];

    const onShouldStartLoadWithRequest = createOnShouldStartLoadWithRequest(
      this.onShouldStartLoadWithRequestCallback,
      // casting cause it's in the default props
      originWhitelist as readonly string[],
      onShouldStartLoadWithRequestProp,
    );

    const decelerationRate = processDecelerationRate(decelerationRateProp);

    const NativeWebView
      = (nativeConfig.component as typeof NativeWebViewIOS | undefined)
      || RNCWebView;

    const webView = (
      <NativeWebView
        key="webViewKey"
        {...otherProps}
        decelerationRate={decelerationRate}
        messagingEnabled={typeof onMessage === 'function'}
        onLoadingError={this.onLoadingError}
        onLoadingFinish={this.onLoadingFinish}
        onLoadingProgress={this.onLoadingProgress}
        onLoadingStart={this.onLoadingStart}
        onHttpError={this.onHttpError}
        onMessage={this.onMessage}
        onScroll={this.props.onScroll}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onContentProcessDidTerminate={this.onContentProcessDidTerminate}
        ref={this._setNativeRef}
        // TODO: find a better way to type this.
        source={resolveAssetSource(this.props.source as ImageSourcePropType)}
        style={webViewStyles}
        {...nativeConfig.props}
      />
    );

    return (
      <View style={webViewContainerStyle}>
        {webView}
        {otherView}
      </View>
    );
  }
}

const ForwardedWebView = React.forwardRef<AdornedRef, IOSWebViewProps>((props, ref) => (
  <WebView {...props} forwardedRef={ref}/>
));

export default ForwardedWebView;