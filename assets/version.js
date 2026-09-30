// Shows the latest release's version beside the download buttons. The
// buttons link to the latest release either way, so a failed request only
// leaves the version out.
fetch( 'https://api.github.com/repos/wpscholar/agentic-editor/releases/latest' )
	.then( function ( res ) {
		return res.ok ? res.json() : Promise.reject( res.status );
	} )
	.then( function ( release ) {
		var tag = String( release.tag_name || '' ).replace( /^v/, '' );
		if ( ! /^[0-9][0-9A-Za-z.+-]*$/.test( tag ) ) {
			return;
		}
		document.querySelectorAll( '[data-version]' ).forEach( function ( el ) {
			el.textContent = 'v' + tag;
			el.hidden = false;
		} );
	} )
	.catch( function () {} );
