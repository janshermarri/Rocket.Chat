import { Box } from '@rocket.chat/fuselage';
import type { ReactElement } from 'react';

import HomePageHeader from './HomePageHeader';
import Page from '../../components/Page/Page';
import PageScrollableContent from '../../components/Page/PageScrollableContent';


const DefaultHomePage = (): ReactElement => {

	return (
		<Page color='default' data-qa='page-home' data-qa-type='default' background='tint'>
			<HomePageHeader />
			<PageScrollableContent>
				<Box is='h2' fontScale='h1' mb={20} data-qa-id='homepage-welcome-text'>
					Welcome to Transmit Chat
				</Box>
			</PageScrollableContent>
		</Page>
	);
};

export default DefaultHomePage;
