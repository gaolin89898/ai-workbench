import 'package:flutter_test/flutter_test.dart';
import 'package:remote_term_mobile/main.dart';

void main() {
  testWidgets('app builds', (tester) async {
    await tester.pumpWidget(const AiWorkbenchApp());

    expect(find.byType(AiWorkbenchApp), findsOneWidget);
  });
}
